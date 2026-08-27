/*
 * Regression guard for the model-capability boundary.
 *
 * `llm_config.context_window` and `llm_config.max_output_tokens` are model
 * facts, not product defaults. A blank/zero value is resolved at runtime by
 * src/services/llm/providerCapabilities.ts. Keep this check deliberately
 * narrow: task-specific demand constants and historical migrations are not
 * capability defaults and therefore are outside this guard.
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourceRoot = path.resolve(__dirname, '..', 'src');
const excludedPath = `${path.sep}services${path.sep}migrations${path.sep}`;
const forbidden = [
  {
    pattern: /\bmax_output_tokens\s*[:=]\s*(?:4000|4096|8192)\b/g,
    message: 'max_output_tokens must be resolved from capability, not a fixed default',
  },
  {
    pattern: /\bmaxOutputTokens\s*[:=]\s*(?:4000|4096|8192)\b/g,
    message: 'maxOutputTokens must be resolved from capability, not a fixed default',
  },
  {
    pattern: /\b(?:max_output_tokens|maxOutputTokens)\s*(?:\?\?|\|\|)\s*(?:4000|4096|8192)\b/g,
    message: 'capability fallback must not manufacture a product-sized output limit',
  },
  {
    pattern: /\b(?:contextWindow|context_window)\s*(?:\?\?|\|\|)\s*(?:4096|8192|128000|1000000)\b/g,
    message: 'context fallback must not impersonate the selected model window',
  },
  {
    pattern: /\bmax_tokens\s+(?:INTEGER\s+[^\n]*?\s+)?DEFAULT\s+(?:4000|4096|8192)\b/gi,
    message: 'legacy asset max_tokens schema defaults must be AUTO/zero',
  },
];

function listSourceFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

const violations = [];
for (const filePath of listSourceFiles(sourceRoot)) {
  if (filePath.includes(excludedPath)) continue;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rule of forbidden) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      violations.push(`${path.relative(process.cwd(), filePath)}:${line} ${rule.message}`);
    }
  }

  // A literal second argument bypasses the shared capability resolver.  This
  // is intentionally an AST check rather than a regex so multiline calls and
  // harmless numeric values elsewhere in a module do not evade the gate.
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'callLLM' || node.expression.text === 'callLLMResult')
    ) {
      const second = node.arguments[1];
      if (second && ts.isNumericLiteral(second)) {
        const line = sourceFile.getLineAndCharacterOfPosition(second.getStart(sourceFile)).line + 1;
        violations.push(
          `${path.relative(process.cwd(), filePath)}:${line} ${node.expression.text} maxTokens must come from provider capabilities / frozen stage capacity, not a fixed numeric argument`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

if (violations.length > 0) {
  console.error('Elastic capability regression detected:');
  for (const violation of violations) console.error(`- ${violation}`);
  console.error(
    'Use the shared resolver and keep 0/blank as AUTO; do not add a model-sized fallback in a screen, store, repository, stage, or provider.',
  );
  process.exitCode = 1;
} else {
  console.log('Elastic capability regression check passed.');
}
