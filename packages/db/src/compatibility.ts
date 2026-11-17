/** Database-independent text matching for the small local inventory. */
export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

export function matchesApplicationSearch(
  application: { displayName: string; publisher: string | null; packageId: string | null },
  query: string,
): boolean {
  const needle = normalizeSearch(query.trim());
  if (!needle) return true;
  return [application.displayName, application.publisher, application.packageId]
    .some(value => value != null && normalizeSearch(value).includes(needle));
}

// CredentialsSchema permits ASCII letters, digits, underscore, dot and hyphen.
// Keep this independent of database collation and preserve the display spelling.
export function normalizedUsername(username: string): string {
  return username.trim().toLowerCase();
}
