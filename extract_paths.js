const fs = require('fs');
let content = fs.readFileSync('c:/Users/frank/Documents/swagger.txt', 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.substring(1);
const lastBrace = content.lastIndexOf('}');
content = content.substring(0, lastBrace + 1);
const s = JSON.parse(content);
const paths = Object.keys(s.paths);
const ops = [];
for (const p of paths) {
    const m = s.paths[p];
    for (const method of Object.keys(m)) {
        const op = m[method];
        const tags = op.tags ? op.tags.join(',') : '';
        const hasBody = (op.parameters || []).some(pr => pr.in === 'body') ? ' [BODY]' : '';
        ops.push(method.toUpperCase() + ' ' + p + ' | ' + (op.operationId || 'N/A') + ' | ' + tags + hasBody);
    }
}
ops.sort();
const lines = ['Total endpoints: ' + ops.length, ...ops, '', '=== UNIQUE TAGS ==='];
const alltags = new Set();
for (const p of paths) {
    const m = s.paths[p];
    for (const method of Object.keys(m)) {
        (m[method].tags || []).forEach(t => alltags.add(t));
    }
}
[...alltags].sort().forEach(t => lines.push(t));
fs.writeFileSync('c:/dev/mcp-prodago/endpoints.txt', lines.join('\n'), 'utf8');
console.log('Done: ' + ops.length + ' endpoints, ' + alltags.size + ' tags');
