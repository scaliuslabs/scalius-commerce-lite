import { describe, expect, it } from "vitest";
import { Hono } from "hono";

describe("Hono request parsing boundaries", () => {
    it("keeps prototype-shaped query and header names as ordinary request data", async () => {
        const app = new Hono();

        app.get("/probe/:value", (context) => {
            const query = context.req.query();
            const queries = context.req.queries();
            const headers = context.req.header();

            return context.json({
                headersHaveNullPrototype: Object.getPrototypeOf(headers) === null,
                queryHasNullPrototype: Object.getPrototypeOf(query) === null,
                queriesHaveNullPrototype: Object.getPrototypeOf(queries) === null,
                headerValues: {
                    constructor: headers["constructor"],
                    prototype: headers["prototype"],
                    proto: headers["__proto__"],
                },
                paramValue: context.req.param("value"),
                queryValues: {
                    constructor: query["constructor"],
                    prototype: query["prototype"],
                    proto: query["__proto__"],
                    repeatedProto: queries["__proto__"],
                },
            });
        });

        const response = await app.request(
            "https://api.scalius.com/probe/__proto__?__proto__=first&__proto__=second&constructor=constructor-value&prototype=prototype-value",
            {
                headers: [
                    ["__proto__", "header-proto"],
                    ["constructor", "header-constructor"],
                    ["prototype", "header-prototype"],
                ],
            },
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            headersHaveNullPrototype: true,
            queryHasNullPrototype: true,
            queriesHaveNullPrototype: true,
            headerValues: {
                constructor: "header-constructor",
                prototype: "header-prototype",
                proto: "header-proto",
            },
            paramValue: "__proto__",
            queryValues: {
                constructor: "constructor-value",
                prototype: "prototype-value",
                proto: "first",
                repeatedProto: ["first", "second"],
            },
        });
    });
});
