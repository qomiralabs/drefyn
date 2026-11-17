import { parseArgs } from 'node:util';
import { createProjects, loadPages, readSet } from '../bench/load.ts';
import { openHarness, scriptArgs, vacuum } from '../bench/stack.ts';

// Recall at 8 and the assistant gate on the #637 set, against compose Postgres:
//   pnpm --filter @drefyn/retrieval eval:recall -- --set <dir>
// The set stays outside the repository and is read by path. Prints counts only, never text.
const RECALL_FLOOR = 170;
const BLOCKED_CEILING = 1;
const GATE = 0.25;

async function main(): Promise<number> {
  const { values } = parseArgs({ args: scriptArgs(), options: { set: { type: 'string' } } });
  if (values.set === undefined) {
    process.stderr.write('usage: eval:recall -- --set <dir with chunks.json and q-*.json>\n');
    return 2;
  }
  const set = readSet(values.set);
  const harness = await openHarness('drefyn_recall');
  try {
    const [project] = await createProjects(harness.name, 1);
    if (project === undefined) throw new Error('no project');
    const ids = await loadPages(harness.name, project, set.pages);
    await harness.rebuild(project);
    await vacuum(harness.name);
    let found = 0;
    let answerable = 0;
    let answerableBlocked = 0;
    let unanswerable = 0;
    let unanswerableBlocked = 0;
    let refused = 0;
    for (const question of set.questions) {
      const result = await harness.retrieval.retrieveScored(project.tenant, {
        query: question.text,
        limit: 8,
      });
      if (!result.ok) refused += 1;
      const coverage = result.ok ? result.value.coverage : 0;
      const gold = question.gold === null ? undefined : ids.get(question.gold);
      if (question.kind === 'answerable') {
        answerable += 1;
        if (result.ok && result.value.hits.some((hit) => hit.chunkId === gold)) found += 1;
        if (coverage < GATE) answerableBlocked += 1;
      } else {
        unanswerable += 1;
        if (coverage < GATE) unanswerableBlocked += 1;
      }
    }
    const chunks = set.pages.reduce((sum, page) => sum + page.chunks.length, 0);
    process.stdout.write(
      [
        `eval:recall: ${String(chunks)} chunks, ${String(set.questions.length)} questions, defaults, limit 8, gate coverage < ${String(GATE)}`,
        `recall at 8: ${String(found)} of ${String(answerable)} (floor ${String(RECALL_FLOOR)})`,
        `answerable blocked: ${String(answerableBlocked)} of ${String(answerable)} (ceiling ${String(BLOCKED_CEILING)})`,
        `unanswerable blocked: ${String(unanswerableBlocked)} of ${String(unanswerable)}`,
        `errors: ${String(refused)}`,
      ].join('\n') + '\n',
    );
    const pass = found >= RECALL_FLOOR && answerableBlocked <= BLOCKED_CEILING && refused === 0;
    process.stdout.write(`eval:recall: ${pass ? 'pass' : 'FAIL'}\n`);
    return pass ? 0 : 1;
  } finally {
    await harness.close();
  }
}

process.exitCode = await main();
