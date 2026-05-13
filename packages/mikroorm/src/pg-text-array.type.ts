import { Type } from '@mikro-orm/core';

/**
 * Custom MikroORM Type for `text[]` PostgreSQL columns that correctly handles
 * all array-literal edge cases that MikroORM v7's built-in `ArrayType` misses.
 *
 * Root cause: `ArrayType.convertToDatabaseValue` delegates to
 * `platform.marshallArray`, whose quote predicate (`/["{},\\]/` or empty string)
 * does NOT cover:
 *   - The literal token `NULL` (unquoted → PG reads it as SQL NULL)
 *   - Elements containing whitespace (unquoted → PG strips boundary whitespace)
 *
 * This type implements the correct quoting rule:
 *   quote if: empty string, OR contains `,`, `{`, `}`, `"`, `\`, whitespace,
 *             OR the uppercased value equals `NULL`.
 *
 * Reading (JS value): delegated to MikroORM's `pg` driver, which parses PG
 * array literals back to JS arrays natively. When the driver delivers a JS
 * array directly (common with testcontainers and modern pg versions) the value
 * is passed through as-is.
 */
export class PgTextArrayType extends Type<string[] | null, string | null> {
  override convertToDatabaseValue(
    value: string[] | null | undefined,
  ): string | null {
    if (value == null) {
      return null;
    }

    const quotedElements = value.map((tag) => {
      const needsQuoting =
        tag.length === 0 ||
        /[,{}"\\\s]/.test(tag) ||
        tag.toUpperCase() === 'NULL';

      if (needsQuoting) {
        const escaped = tag.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `"${escaped}"`;
      }

      return tag;
    });

    return `{${quotedElements.join(',')}}`;
  }

  override convertToJSValue(
    value: string | string[] | null | undefined,
  ): string[] | null {
    if (value == null) {
      return null;
    }

    // The pg driver may already have parsed the PG array literal into a JS array.
    if (Array.isArray(value)) {
      return value as string[];
    }

    // Fallback: parse the PG array literal string manually.
    return this.parsePgArrayLiteral(value);
  }

  override compareAsType(): string {
    return 'string[]';
  }

  override toJSON(value: string[] | null): string[] | null {
    return value;
  }

  override getColumnType(): string {
    return 'text[]';
  }

  /**
   * Parses a PostgreSQL array literal (e.g. `{"a,b","a\"b",NULL}`) into a JS
   * string array. Handles quoted elements, escaped characters inside quotes, and
   * unquoted elements (including bare `NULL` which becomes the string `'NULL'`
   * — at this point any SQL NULL has already become a JS null and is handled
   * by the null-check at the top of `convertToJSValue`).
   */
  private parsePgArrayLiteral(literal: string): string[] {
    if (literal === '{}') {
      return [];
    }

    // Strip the outer braces.
    const inner = literal.slice(1, -1);
    const result: string[] = [];
    let i = 0;

    while (i < inner.length) {
      if (inner[i] === '"') {
        // Quoted element: read until closing unescaped `"`.
        i++; // skip opening quote
        let element = '';
        while (i < inner.length) {
          if (inner[i] === '\\' && i + 1 < inner.length) {
            element += inner[i + 1];
            i += 2;
          } else if (inner[i] === '"') {
            i++; // skip closing quote
            break;
          } else {
            element += inner[i];
            i++;
          }
        }
        result.push(element);
      } else {
        // Unquoted element: read until the next comma.
        let end = inner.indexOf(',', i);
        if (end === -1) {
          end = inner.length;
        }
        result.push(inner.slice(i, end));
        i = end;
      }

      // Skip the comma separator.
      if (i < inner.length && inner[i] === ',') {
        i++;
      }
    }

    return result;
  }
}
