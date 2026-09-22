/**
 * Нормализация текста для поиска.
 *
 * SQLite в сборке Node не знает Unicode для LIKE/LOWER (складывает регистр
 * только у ASCII), поэтому приводим строки к нижнему регистру на стороне JS
 * и храним результат в отдельных колонках. Заодно «ё» → «е»: пользователи
 * почти никогда не ставят точки над ё, а искать должны находить.
 */
export function foldCase(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е');
}

/** Экранирование спецсимволов LIKE, чтобы «100%» искалось буквально. */
export function escapeLike(value) {
  return String(value ?? '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Подсветка совпадения в сниппете: возвращает [{text, hit}]. */
export function highlight(text, query) {
  const source = String(text ?? '');
  const foldedSource = foldCase(source);
  const foldedQuery = foldCase(query).trim();
  if (!foldedQuery) return [{ text: source, hit: false }];

  const parts = [];
  let cursor = 0;
  let index = foldedSource.indexOf(foldedQuery);
  while (index !== -1) {
    if (index > cursor) parts.push({ text: source.slice(cursor, index), hit: false });
    parts.push({ text: source.slice(index, index + foldedQuery.length), hit: true });
    cursor = index + foldedQuery.length;
    index = foldedSource.indexOf(foldedQuery, cursor);
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), hit: false });
  return parts.length ? parts : [{ text: source, hit: false }];
}
