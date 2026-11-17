export function csv(rows: (string | number | null | undefined)[][]): string {
  const escape = (value: string | number | null | undefined) => {
    let text = value == null ? "" : String(value);
    // Spreadsheet software may execute formulas even inside quoted CSV cells.
    if (/^[\s\t\r\n]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + rows.map(row => row.map(escape).join(",")).join("\r\n") + "\r\n";
}
