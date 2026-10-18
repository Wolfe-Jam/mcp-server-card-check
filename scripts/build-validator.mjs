/**
 * Precompile the v1 Server Card schema into a standalone validator
 * (src/validator-standalone.cjs): ajv "standalone" emits plain code with no runtime
 * code generation, so it runs in a Cloudflare Worker (eval / new Function are
 * banned there). Formats (uri, …) are included, matching the CLI's validator.
 * Re-run after the schema changes: npm run build:validator
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { readFileSync, writeFileSync } from "node:fs";

const addFormats = addFormatsModule.default ?? addFormatsModule;
const schema = JSON.parse(readFileSync("schema/server-card.schema.v1.json", "utf8"));
const ajv = new Ajv2020({ code: { source: true }, strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema, "server-card");
const validate = ajv.getSchema("server-card#/$defs/ServerCard");
if (!validate) throw new Error("could not resolve #/$defs/ServerCard");
writeFileSync("src/validator-standalone.cjs", standaloneCode(ajv, validate));
console.log("src/validator-standalone.cjs generated (ajv standalone, formats included, no runtime eval)");
