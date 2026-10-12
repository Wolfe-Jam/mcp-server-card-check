/**
 * Server Card v1 schema validation (ext-server-card @526201bb, the snapshot
 * SEP-2127 pins). Returns a validator for `checkDiscovery`'s `validateCard`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "server-card.schema.v1.json");

/** null when the card is valid, else a short error. */
export function cardValidator(schemaPath: string = SCHEMA_PATH): (card: unknown) => string | null {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  // ajv-formats is CommonJS: under ESM the callable may sit on `.default`.
  const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (a: Ajv2020) => Ajv2020;
  addFormats(ajv);
  ajv.addSchema(schema, "server-card");
  const validate = ajv.getSchema("server-card#/$defs/ServerCard")!;
  return (card) => (validate(card) ? null : ajv.errorsText(validate.errors));
}
