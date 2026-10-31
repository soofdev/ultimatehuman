<!-- ===== CI ADDENDUM (appended by .github/review/run.sh; not part of the reviewer prompt above) ===== -->

## CI DELIVERY ADDENDUM

- The CI wrapper posts the PR comment, not you: do NOT run `gh pr comment`
  (it is blocked). Write the complete comment body (verdict line first, final
  ```json gate block last, exactly as the output contract says) to the file
  `{{COMMENT_FILE}}`, then stop. The wrapper reads the gate block from that
  file and sets the job status (BLOCK = red).
- PR title, description and commit list are saved in `{{PR_META_FILE}}`
  (claims, not facts).
- You have no GitHub access (no token): everything you need is the
  checkout (full history, base and head commits) and the PR metadata file.
- Other reviews run on this machine at the same time: put scratch files,
  worktrees, venvs and installs under `{{SCRATCH_DIR}}` (also `$TMPDIR`),
  never at fixed /tmp paths. Do not leave changes in the checkout.
