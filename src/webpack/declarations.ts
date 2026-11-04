/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type Expression, type FunctionExpression, parse, type Pattern, type Statement } from "acorn";

export interface FactoryDeclarationSource {
    source: string;
    names: readonly string[];
}

function expression(source: string): Expression | undefined {
    try {
        const program = parse(`(${source})`, { ecmaVersion: "latest", sourceType: "script" });
        const statement = program.body[0];
        return statement?.type === "ExpressionStatement" ? statement.expression : undefined;
    } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
    }
}

function bindingNames(pattern: Pattern, names: Set<string>) {
    switch (pattern.type) {
        case "Identifier": names.add(pattern.name); break;
        case "AssignmentPattern": bindingNames(pattern.left, names); break;
        case "RestElement": bindingNames(pattern.argument, names); break;
        case "ArrayPattern":
            for (const element of pattern.elements) if (element) bindingNames(element, names);
            break;
        case "ObjectPattern":
            for (const property of pattern.properties)
                bindingNames(property.type === "RestElement" ? property.argument : property.value, names);
            break;
    }
}

function nestedVars(statement: Statement, names: Set<string>) {
    switch (statement.type) {
        case "VariableDeclaration":
            if (statement.kind === "var") for (const declaration of statement.declarations) bindingNames(declaration.id, names);
            break;
        case "BlockStatement":
            for (const child of statement.body) nestedVars(child, names);
            break;
        case "IfStatement":
            nestedVars(statement.consequent, names);
            if (statement.alternate) nestedVars(statement.alternate, names);
            break;
        case "ForStatement":
            if (statement.init?.type === "VariableDeclaration") nestedVars(statement.init, names);
            nestedVars(statement.body, names);
            break;
        case "ForInStatement":
        case "ForOfStatement":
            if (statement.left.type === "VariableDeclaration") nestedVars(statement.left, names);
            nestedVars(statement.body, names);
            break;
        case "WhileStatement":
        case "DoWhileStatement":
        case "LabeledStatement":
        case "WithStatement":
            nestedVars(statement.body, names);
            break;
        case "SwitchStatement":
            for (const branch of statement.cases) for (const child of branch.consequent) nestedVars(child, names);
            break;
        case "TryStatement":
            nestedVars(statement.block, names);
            if (statement.handler) nestedVars(statement.handler.body, names);
            if (statement.finalizer) nestedVars(statement.finalizer, names);
            break;
    }
}

function callable(node: Expression | undefined) {
    if (node?.type === "SequenceExpression") node = node.expressions.at(-1);
    return node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression" ? node : undefined;
}

export function exposeFactoryDeclarations(source: string): FactoryDeclarationSource | undefined {
    let factory = callable(expression(source));
    if (!factory) {
        const object = expression(`{${source}}`);
        const property = object?.type === "ObjectExpression" && object.properties.length === 1 ? object.properties[0] : undefined;
        if (property?.type !== "Property" || !property.method || property.kind !== "init" || property.value.type !== "FunctionExpression") return;
        const method: FunctionExpression = property.value;
        if (method.async || method.generator) return;
        source = `function${source.slice(method.start - 2, method.end - 2)}`;
        factory = callable(expression(source));
    }
    if (!factory || factory.async || factory.generator || factory.body.type !== "BlockStatement" || factory.params[0]?.type !== "Identifier") return;
    const names = new Set<string>();
    for (const statement of factory.body.body) {
        if (statement.type === "VariableDeclaration") {
            for (const declaration of statement.declarations) bindingNames(declaration.id, names);
        } else if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
            if (statement.id) names.add(statement.id.name);
        } else nestedVars(statement, names);
    }
    if (!names.size) return;
    const occupied = new Set(names);
    for (const parameter of factory.params) bindingNames(parameter, occupied);
    if (factory.type === "FunctionExpression" && factory.id) occupied.add(factory.id.name);
    function unique(base: string) {
        while (occupied.has(base)) base += "_";
        occupied.add(base);
        return base;
    }
    const objectName = unique("__noyucordObject");
    const valueName = unique("__noyucordValue");
    const descriptors = [...names].map(name => `[${JSON.stringify(name)}]:{enumerable:true,get:()=>${name},set:${valueName}=>{${name}=${valueName}}}`).join(",");
    let position = factory.body.start;
    for (const statement of factory.body.body) {
        if (statement.type !== "ExpressionStatement" || statement.directive === undefined) break;
        position = statement.end - 1;
    }
    const injection = `;${factory.params[0].name}.declarations=${objectName}.seal(${objectName}.defineProperties(${objectName}.create(null),{${descriptors}}));`;
    const instrumented = source.slice(0, position) + injection + source.slice(position);
    return { source: `((${objectName})=>(${instrumented}))(Object)`, names: [...names] };
}
