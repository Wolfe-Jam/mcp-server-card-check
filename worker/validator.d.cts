declare const validate: ((card: unknown) => boolean) & { errors?: unknown[] | null };
export default validate;
