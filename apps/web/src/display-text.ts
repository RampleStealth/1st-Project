const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: "\""
};

function codePoint(value: string) {
  const numeric = value[1]?.toLowerCase() === "x" ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value.slice(1), 10);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff && !(numeric >= 0xd800 && numeric <= 0xdfff)
    ? String.fromCodePoint(numeric)
    : null;
}

/** Decodes one recognized character reference for React text rendering; it never parses HTML. */
export function decodeDisplayEntities(value: string | null | undefined) {
  if (!value) return value ?? "";
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|apos|gt|lt|quot);/gi, (reference, entity: string) => {
    if (entity.startsWith("#")) return codePoint(entity) ?? reference;
    return namedEntities[entity.toLowerCase()] ?? reference;
  });
}
