/**
 * Static extraction of the nodes a conditional edge can route to.
 *
 * Readiness in the executor asks a question in-degree alone cannot answer:
 * *could* some edge still route to this node? A direct edge declares its
 * target, but a conditional edge is an opaque function, so its targets have to
 * be recovered from the source before the sandbox turns it into a closure.
 *
 * Without this, a node reached only by conditional edges has no incoming edges
 * to count, so it looks ready immediately and runs whether or not anything
 * routed to it — a `green -> deploy | rollback` graph runs *both* branches.
 *
 * Extraction is deliberately conservative. Being wrong in the "too many
 * targets" direction only delays a node until the edge resolves (and, because
 * an edge decrements exactly the set it claimed, over-claiming cancels out).
 * Being wrong in the "too few" direction reintroduces the bug. So anything
 * that cannot be read statically is reported as unanalysable rather than
 * guessed at.
 */

import type { Node } from "acorn";

type AstNode = Node & { [key: string]: unknown; type: string };

/** What a source node's conditional edges can route to. */
export interface ConditionalTargets {
	/**
	 * Node ids the conditional edges leaving this node may select, unioned
	 * across all of them.
	 *
	 * A union rather than per-edge lists: matching AST call sites to built
	 * edges positionally breaks as soon as a script builds edges in a loop.
	 * The union is safe because every edge decrements the same set it claims,
	 * so the over-claim is self-cancelling and adds no delay (all of a node's
	 * edges resolve in the same round).
	 */
	targets: string[];
	/** True when some conditional edge can return END. */
	usesEnd: boolean;
	/**
	 * False when a target could not be determined statically — a non-inline
	 * function (`g.edge('x', someFn)`) or a computed target (`=> r.next`).
	 *
	 * The caller must fall back to a conservative claim. This flag exists
	 * because a computed target yields an *empty* target list, which is
	 * otherwise indistinguishable from "routes nowhere" and would silently
	 * under-claim.
	 */
	analysable: boolean;
}

function isAstNode(value: unknown): value is AstNode {
	return !!value && typeof value === "object" && typeof (value as AstNode).type === "string";
}

function childrenOf(node: AstNode): AstNode[] {
	const children: AstNode[] = [];
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const entry of value) if (isAstNode(entry)) children.push(entry);
		} else if (isAstNode(value)) {
			children.push(value);
		}
	}
	return children;
}

/** True for `<something>.edge(...)`. */
function isEdgeCall(node: AstNode): boolean {
	if (node.type !== "CallExpression") return false;
	const callee = node.callee as AstNode | undefined;
	if (callee?.type !== "MemberExpression") return false;
	const property = callee.property as AstNode | undefined;
	return property?.type === "Identifier" && property.name === "edge";
}

/**
 * Positions where a value becomes the edge's return value.
 *
 * A string literal here is a routing target; a string literal anywhere else
 * (`result.status === 'blocked'`) is a comparison and must not be collected.
 */
function collectReturnedExpressions(fnBody: AstNode): AstNode[] {
	const returned: AstNode[] = [];

	// Expression-bodied arrow: `(s, r) => r.ok ? 'a' : 'b'`
	if (fnBody.type !== "BlockStatement") {
		returned.push(fnBody);
	}

	const walk = (node: AstNode): void => {
		if (node.type === "ReturnStatement") {
			const argument = node.argument;
			if (isAstNode(argument)) returned.push(argument);
		}
		// Do not descend into nested functions: their returns belong to them.
		if (
			node.type === "FunctionExpression" ||
			node.type === "FunctionDeclaration" ||
			node.type === "ArrowFunctionExpression"
		) {
			if (node !== fnBody) return;
		}
		for (const child of childrenOf(node)) walk(child);
	};

	if (fnBody.type === "BlockStatement") walk(fnBody);

	return returned;
}

/**
 * Reads the possible values of one returned expression.
 *
 * Recurses through the shapes an edge legitimately uses to pick between
 * targets — a ternary, or `a || b` — so both arms are collected.
 */
function readReturnedValue(
	expression: AstNode,
	found: { targets: Set<string>; usesEnd: boolean; dynamic: boolean },
): void {
	switch (expression.type) {
		case "Literal":
			if (typeof expression.value === "string") found.targets.add(expression.value);
			// A non-string literal (null, number) is not a valid target; the
			// executor rejects it at runtime with a clear routing error.
			return;

		case "Identifier":
			if (expression.name === "END") found.usesEnd = true;
			// Any other bare identifier is a variable holding an unknown target.
			else found.dynamic = true;
			return;

		case "ConditionalExpression":
			for (const branch of [expression.consequent, expression.alternate]) {
				if (isAstNode(branch)) readReturnedValue(branch, found);
			}
			return;

		case "LogicalExpression":
			for (const side of [expression.left, expression.right]) {
				if (isAstNode(side)) readReturnedValue(side, found);
			}
			return;

		case "TemplateLiteral": {
			const quasis = expression.quasis;
			const expressions = expression.expressions;
			// A template with no interpolation is just a string literal.
			if (Array.isArray(expressions) && expressions.length === 0 && Array.isArray(quasis)) {
				const text = quasis
					.map((q) => (isAstNode(q) ? ((q.value as { cooked?: string })?.cooked ?? "") : ""))
					.join("");
				found.targets.add(text);
			} else {
				found.dynamic = true;
			}
			return;
		}

		default:
			// MemberExpression (`r.next`), CallExpression, etc. — computed at
			// runtime, so the target cannot be known here.
			found.dynamic = true;
	}
}

/**
 * Extracts, per source node, the targets its conditional edges can select.
 *
 * `declaredNodeIds` filters the results: an edge body contains string literals
 * that are comparisons rather than targets (`result.status === 'blocked'`), and
 * intersecting with real node ids removes them. A target that is not a declared
 * node would be a routing error anyway, and the executor reports that at
 * runtime with a better message than this could.
 */
export function extractConditionalTargets(
	ast: AstNode,
	declaredNodeIds: Set<string>,
): Map<string, ConditionalTargets> {
	const bySource = new Map<string, ConditionalTargets>();

	const record = (from: string): ConditionalTargets => {
		let entry = bySource.get(from);
		if (!entry) {
			entry = { targets: [], usesEnd: false, analysable: true };
			bySource.set(from, entry);
		}
		return entry;
	};

	const visit = (node: AstNode): void => {
		if (isEdgeCall(node)) {
			const args = node.arguments as AstNode[] | undefined;
			const fromArg = args?.[0];
			const targetArg = args?.[1];

			// Only `g.edge("literal", fn)` can be attributed to a source node.
			// A computed source id is rare and not worth guessing at.
			const from =
				fromArg?.type === "Literal" && typeof fromArg.value === "string"
					? fromArg.value
					: null;

			if (from && targetArg) {
				const isInlineFunction =
					targetArg.type === "ArrowFunctionExpression" ||
					targetArg.type === "FunctionExpression";

				// A direct edge (string literal or END identifier) declares its
				// own target and needs nothing from this module.
				const isDirect =
					targetArg.type === "Literal" ||
					(targetArg.type === "Identifier" && targetArg.name === "END");

				if (!isDirect) {
					const entry = record(from);
					if (!isInlineFunction) {
						// `g.edge('x', someFn)` — the body is not here to read.
						entry.analysable = false;
					} else {
						const body = targetArg.body;
						if (!isAstNode(body)) {
							entry.analysable = false;
						} else {
							const found = {
								targets: new Set<string>(),
								usesEnd: false,
								dynamic: false,
							};
							for (const returned of collectReturnedExpressions(body)) {
								readReturnedValue(returned, found);
							}
							if (found.dynamic) entry.analysable = false;
							if (found.usesEnd) entry.usesEnd = true;
							for (const target of found.targets) {
								if (declaredNodeIds.has(target) && !entry.targets.includes(target)) {
									entry.targets.push(target);
								}
							}
						}
					}
				}
			}
		}

		for (const child of childrenOf(node)) visit(child);
	};

	visit(ast);
	return bySource;
}
