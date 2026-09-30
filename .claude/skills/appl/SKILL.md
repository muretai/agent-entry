---
name: appl
description: File a requirement with APPL (Agent Parallel Proof Loop) -- 'APPL' is a proper noun, not 'apply'. Use when the person says 'XX を APPL して', 'APPL this', 'use APPL for XX', 'add to the backlog', 'queue XX', 'later:' or 'idea:' (also 'バックログに積んで', 'アイディア'). Hands their sentence, verbatim, to the vendored parser, which files an intake now or an idea in the backlog inbox; never implement, never land, never spawn.
---

# APPL: file it, say where, stop

**APPL is the name of a pipeline (Agent Parallel Proof Loop). It is not the verb "apply" and not 「適用」.** A sentence that asks for APPL means ONE thing: file it, so a separate coordinator session runs it through test author -> implementer -> reviewer -> publisher, now or when the backlog reaches it. 「適用して」 / "apply this" is NOT APPL; if you are unsure which the person meant, ask, do not act.

When asked to APPL something, or to put it in the backlog, do exactly this and nothing else:

1. Do NOT implement, edit files, create or reclaim worktrees, start Herdr workers, land, commit, push, redeploy anything, or "coordinate" the task yourself. A session that does any of that has misread the instruction.
2. From the top of the repository the person is talking about, hand their sentence to the parser. Paste the sentence EXACTLY as they wrote it -- trigger words, priority words and all, not restated, not translated, not quoted or escaped -- on the one line between the heredoc markers. The quoted marker (`<<'APPL_SENTENCE'`) means nothing in it is expanded or run.

   ```bash
   APPL_FROM="claude:<your model>" python3 .cursor/skills/isolated-session/scripts/appl-phrase.py -- "$(cat <<'APPL_SENTENCE'
   <the person's sentence, verbatim, on one line>
   APPL_SENTENCE
   )"
   ```

   The parser owns the phrase table (which words mean now or later, a priority, an order, a note, a ruling, a solo item), picks the filing script, and refuses a sentence it cannot file safely. Do not decide any of that yourself, and do not call a filing script directly.
3. Relay what it printed, in one line, and stop:
   - exit 0: the line names what was filed (an intake, or an idea in the backlog inbox), the repository and the path. The coordinator picks it up; the result does not come back to this chat.
   - a question (the line ends in `?`): the sentence was ambiguous and NOTHING was filed. Ask the person that question. Their answer is a new sentence; hand it over the same way. When the question was whether to file now or queue, and they answer "the backlog", run the same command with `--backlog` before `--`, on the same sentence.
   - exit 3 with an `appl-add:` line: the intake IS filed but the coordinator was not woken. Pass that line on unchanged.
   - any other refusal (`appl-phrase:` on stderr): pass it on unchanged. Nothing was filed. Do not work around it.

If the parser is not in this repository, say so and stop: the repository has not vendored APPL (`vendor.sh pull --ref <tag>`). Do not substitute your own implementation.

If the person later asks "did APPL take it?", read the filed file's `status:` line; do not start work.
