"use strict";

function customInstructions(input) {
  return input.instructions ? `\nImportant! Custom Instructions:\n${input.instructions}\n` : "";
}

function issuePrompt(input) {
  return `You are investigating issue ${input.target.url} on repository ${input.repo}.

1. Read and follow the applicable AGENTS.md. Investigate and reproduce the issue before editing. Use $ask-pro:ask-pro only if the problem is genuinely difficult.
2. Prepare the smallest complete fix and run $review-suite:review-plan before implementation.
3. Dispatch one implementation subagent to implement and validate the fix. Review its work and keep it minimal.
4. Run $ponytail:ponytail-review once, then $review-suite:review (note: herdrdev/herdr uses mode fast).
5. Push the branch and open a pull request. Do not merge it. Handle CI and any automated reviewers present; verify findings and reply to every addressed inline comment.
6. Leave a concise recap with the root cause, fix, validation, review state, and pull-request URL.
${customInstructions(input)}`;
}

function taskPrompt(input) {
  return `You are implementing this request on repository ${input.repo}:

${input.request}

1. Read and follow the applicable AGENTS.md. Investigate the repository and choose the smallest correct approach before editing.
2. If the plan is tricky, use $ask-pro:ask-pro before implementation; otherwise run $review-suite:review-plan.
3. Dispatch one implementation subagent to implement and validate the change. Review its work and keep it minimal.
4. Run $ponytail:ponytail-review once, then $review-suite:review (note: herdrdev/herdr uses mode fast).
5. Push the branch and open a pull request. Do not merge it. Handle CI and any automated reviewers present; verify findings and reply to every addressed inline comment.
6. Leave a concise recap with the approach, implementation, validation, review state, and pull-request URL.
`;
}

function prPrompt(input) {
  return `You are reviewing pull request ${input.prUrl} on repository ${input.repo}.

1. Read and follow the applicable AGENTS.md. Stay strictly read-only: do not edit, commit, push, comment, review, or merge.
2. Inspect the complete pull request, checks, reviews, and comments. Explain what it does, why, and the relevant architecture.
3. Judge whether it is the smallest correct change. Use $ponytail:ponytail-review and $ask-pro:ask-pro when the judgment is difficult.
4. For a tricky pull request, run $review-suite:review (note: herdrdev/herdr uses mode fast).
5. Leave a concise recap with risks, verified findings, and actionable review recommendations.
${customInstructions(input)}`;
}

module.exports = { issuePrompt, prPrompt, taskPrompt };
