# Landing a change

Agent Entry lands every change through a GitHub pull request. No one pushes to
`main` directly.

## How a change lands

1. Work happens on a `feat/*` branch.
2. The publisher pushes the `feat/*` branch and opens a pull request against
   `main`. The publisher is the only account that pushes branches and opens pull
   requests.
3. The pull request must pass the required check `test`. That check is the
   `test` job in `.github/workflows/test.yml`: it runs `npm ci` and `npm test` on
   Node 22 on `ubuntu-latest`, and it times out after 5 minutes.
4. The pull request joins the merge queue. The merge queue runs the `test` check
   again on the queued result, through the `merge_group` trigger, and merges it
   into `main` only when the check passes.

The plain-HTTP fixture warning that `npm test` prints is tolerated. The workflow
does not suppress it, and a failing test fails the check.

## Owner steps: protect main

These steps are done by the repository owner in the GitHub settings. They are not
done by the workflow or by any agent.

1. Open Settings, then Branches, and add a branch protection rule for `main`.
   With rulesets, open Settings, then Rules, then Rulesets, and target `main`.
2. Turn on "Require a pull request before merging".
3. Turn on "Require status checks to pass before merging" and add `test` as a
   required status check.
4. Turn on "Require merge queue".
5. Turn on "Restrict who can push to matching branches", or "Restrict updates" in
   a ruleset, so that only the merge queue updates `main`.
6. Save the rule. `main` is now protected.

`.github/CODEOWNERS` exists but has no rules yet.
