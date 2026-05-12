/**
 * Serializes a JS string array to a PostgreSQL text-array literal string,
 * e.g. `['plan', 'my tag']` → `'{plan,"my tag"}'`.
 *
 * MikroORM's `connection.execute()` inlines parameters via `platform.escape()`,
 * which for a JS Array produces `'el1', 'el2'` — not a valid array literal.
 * Converting to a string first causes `escape()` to call `escapeLiteral()`,
 * producing `'{plan,"my tag"}'::text[]` which PostgreSQL accepts.
 *
 * Quoting rules (per PostgreSQL array-input syntax):
 * - An element that contains commas, braces, backslashes, double-quotes,
 *   whitespace, or is the unquoted keyword NULL must be double-quoted.
 * - Inside double-quoted elements, backslash and double-quote are escaped
 *   with a backslash.
 *
 * Returns `null` when the input is null or undefined.
 */
export function toPostgresArrayLiteral(
  tags: string[] | null | undefined,
): string | null {
  if (tags == null) {
    return null;
  }

  const elements = tags.map((tag) => {
    // Elements that need quoting: empty string, contain special chars, or are the NULL keyword
    const needsQuoting =
      tag.length === 0 ||
      /[,{}\\"'\s]/.test(tag) ||
      tag.toUpperCase() === 'NULL';

    if (needsQuoting) {
      // Escape backslashes then double-quotes
      const escaped = tag.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    return tag;
  });

  return `{${elements.join(',')}}`;
}
