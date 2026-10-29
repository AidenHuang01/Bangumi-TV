// Exact public aliases, never fuzzy/substring matching across seasons.
export function bangumiAliases(item) {
  const aliases = (item.infobox || []).filter(row => row.key === '别名')
    .flatMap(row => Array.isArray(row.value) ? row.value.map(value => value.v) : [row.value]);
  return [...new Set([item.name_cn, item.name, ...aliases]
    .filter(value => typeof value === 'string' && value.trim() && value.length <= 200))];
}
