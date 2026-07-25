# Camunda Git Plugin

A Camunda Modeler plugin that adds VS Code–style Git/GitHub/GitLab tooling
to the modeler: local git status/diff/commit/push/pull, PR/MR creation,
an open-issues list, and a visual diff of a BPMN diagram against its last
commit.

It only uses Camunda Modeler's **menu** contribution point — everything
runs in the Electron main process (full Node access), so there's no
webpack bundling step required.

## Install

1. Copy this whole `camunda-git-plugin` folder into your Camunda Modeler
   plugins directory:
   - macOS: `~/Library/Application Support/camunda-modeler/plugins`
   - Windows: `%APPDATA%\camunda-modeler\plugins`
   - Linux: `~/.config/camunda-modeler/plugins`

   (Modeler > Help > "Show plugins folder" / "Open Plugins Folder" will
   take you straight there if you're not sure.)

2. Install dependencies inside the copied folder:

   ```sh
   cd "<plugins-dir>/camunda-git-plugin"
   npm install
   ```

3. Restart Camunda Modeler. A new **Plugins** menu (or entries at the
   bottom of an existing one, depending on your Modeler version) will
   show the actions below.

## Getting started (the setup phase)

Everything else in the plugin assumes a working repository: a folder, a git
directory, an identity to attribute save points to, and at least one
commit. Until all of that exists every panel reports something technically
accurate and completely unactionable - *"not a git repository"*, *"ambiguous
argument 'HEAD'"* - to someone whose actual question is "how do I start".

So setup is a phase with its own state (`menu/setup-service.js`), not an
error condition. The **My work** tab shows an ordered checklist until the
project is usable:

| Step | What it does |
|---|---|
| Choose where your diagrams live | Pick a folder, **or** get a copy of the team's project from a link |
| Start keeping track of changes | `git init -b main` - files are not touched |
| Say who you are | `user.name`/`user.email`, written to **this project only** |
| Create the first save point | Commits what is already there, so there is a history to build on |
| Connect the team server *(optional)* | Adds `origin`, and checks it answers before accepting it |
| Agree how the team works *(optional)* | Writes `.camunda-git.json` - see below |

It is a checklist rather than a wizard because people arrive halfway
through - a folder that is already a repo but has no commits, say - and
need to see where they are, not be walked from step one. Steps that are not
yet reachable stay visible but dimmed, so what is coming is legible.

Three details that are deliberate:

- **`git init -b main`**, not git's compiled-in default, so a new project
  does not start on `master` and immediately disagree with the team's
  settings.
- **Identity is written per project, never `--global`.** A setup screen that
  silently changes the attribution of every other repository on the machine
  is not one anybody asked for.
- **The server address is verified with `ls-remote` before it is accepted.**
  A typo otherwise surfaces much later as a failed push, looking like a
  different problem entirely.

Cloning handles the case where the server's `HEAD` points at a branch that
does not exist - a hand-made bare repo does this often - by checking out a
real branch instead of leaving an empty folder with no explanation.

## Usage

Once setup is done, the menu items below are also available. **"Git:
Repository Settings..."** points the plugin at a different folder.
You can optionally add a GitHub and/or GitLab personal access token at
the same time — only needed for listing issues on private repos or to
raise your API rate limit.

| Menu item | What it does |
|---|---|
| Git: Repository Settings... | Configure the repo path + optional GitHub/GitLab tokens |
| Git: Status & Diff | Opens a panel with branch, changed files, staged/unstaged diffs, and a commit box |
| Git: Commit All Changes... | Prompts for a message, then `git add -A && git commit` |
| Git: Push / Git: Pull | Runs against `origin` |
| Diagram: Show Visual Diff vs Last Commit... | Pick a `.bpmn` file; renders it and highlights elements added/changed since `HEAD` (via `bpmn-js-differ`), with removed elements listed in the sidebar |
| GitHub: Open Repository | Opens `origin` on github.com |
| GitHub: Create Pull Request... | Opens the GitHub compare/PR page for two branches you choose |
| GitHub: List Open Issues | Shows open issues in a small window; click a title to open it in your browser |
| GitLab: Open Repository / Create Merge Request... / List Open Issues | Same as above, for GitLab (self-hosted GitLab works too — set the host in Repository Settings) |

## Architecture: the client bridge

The plugin has two halves that cannot talk to each other directly.

**Why:** Modeler's preload exposes a *hardcoded allowlist* of IPC channels
and throws `Disallowed event` for anything else. There is no
plugin-extensible channel, and nothing in the list can run a subprocess.
So a `script` (renderer) plugin cannot call git.

**The bridge:** the main-process half already has full Node access, so it
serves a tiny HTTP API on `127.0.0.1` and the React half fetches from it.
Modeler's CSP is `script-src 'self'` with no `default-src`, so
`connect-src` is unrestricted and this is allowed.

```
  renderer (client/)                    main process (menu/)
  ------------------                    --------------------
  <Fill slot="status-bar__app">
        |
        |  1. <script src="<own dir>/bridge.js">
        |     sets window.__camundaGitBridge = {port, token}  <-- written by
        |                                                        bridge-server
        |  2. fetch http://127.0.0.1:45678/status?token=...
        +--------------------------------------------->  bridge-server.js
                                                              |
                                                          git-service.js
```

`bridge.js` is regenerated on every launch with a fresh token; requests
without it get a 403. The server binds loopback only.

**Step 1 is fiddly for two separate reasons, both already paid for:**

1. It cannot use `fetch()`. `app-plugins://` is not a registered Electron
   protocol - Modeler redirects it to `file://` from a
   `webRequest.onBeforeRequest` hook - and `fetch()` rejects an
   unrecognised URL scheme before any redirect applies. Hence a `<script>`
   tag, and hence executable JS rather than JSON.
2. It cannot hardcode `app-plugins://` either. The app's CSP is
   `script-src 'self'`, and that scheme is not "self", so the tag is
   refused outright.

The way out: whatever URL Modeler used to load `client.js` is by
definition CSP-allowed. The client reads `document.currentScript.src` and
swaps the filename, so `bridge.js` is written *into `client/dist/`* next
to the bundle. Nothing in the client assumes a path or a scheme.

**Known sharp edge:** the port is fixed at 45678. If it is already taken,
the server logs the `EADDRINUSE` and gives up, and the status bar shows
`⎇ —` with the reason in its tooltip. Modeler is not otherwise affected.

**Consequence:** the plugin `name` in `index.js` is also the host segment
of the `app-plugins://` URL, so it must stay URL-safe (no spaces).

### Client-side UI

Bottom-panel tabs plus the status bar:

| Tab | Contents |
|---|---|
| **My work** | Where you are · workstream · Save my work · I'm finished |
| **Source Control** | Sync buttons and the step-by-step file list |
| **Diagrams** | File explorer: folder tree of every `.bpmn`/`.dmn`/`.form`, changed ones marked, click to open |
| **History** | Branch graph across all branches - see below |
| **Activity** | Every git command the plugin has run, plus a console - see below |
| **Git Settings** | Folder, project setup, developer mode, auto-pull, tokens |

The routines have their own tab because they are the point of the plugin
for a non-technical user, and they were previously stacked above a file
list that most of that audience never needs to read. Source Control is now
about the files, which is what someone who opens a tab with that name is
looking for.

### Where am I (`menu/context-service.js`)

Both routine tabs open with a one-line summary - folder, workstream,
change count - that expands into the answers a support conversation
actually needs: which folder this is, which server "send to the team"
reaches, who commits will be attributed to, what the last save point was,
and whether the project layout was configured or guessed.

Those questions only matter when something is wrong, which is exactly when
nobody can find them. The expanded form is dense and plain on purpose: it
is meant to be screenshotted and pasted to whoever supports this team.

Every section degrades independently - no remote, no commits and no
configured identity are all normal on someone's first day, not errors.

### Keeping up to date

`/status` is polled every 5 seconds and now carries a `revision` stamp:
branch, HEAD, upstream, ahead/behind, and every file's path *and* index
state. When it moves, the tabs that are not polled - file tree, history,
workstreams, activity, context - reload themselves.

Deriving it from git's own answers rather than watching the filesystem
means a diagram saved by Modeler, a commit made in a terminal, and a branch
created in the plugin's own console all register the same way. Including
each file's index state rather than just a count is what makes *staging* a
file count as a change.

Two more triggers, because the stamp cannot see everything:

- **Switching tabs** reloads that tab. Things that changed outside the
  repository - a settings file edited by hand, a branch someone else pushed
  - are invisible to the stamp, and a stale panel is most noticeable at the
  moment attention moves to it.
- **Window focus** re-polls immediately, for the user who went to a
  terminal, committed something, and came back expecting the panel to
  already know.

The alternative - polling every route on the 5s tick - would put a
`git log` and a `git ls-files` behind every tick for a panel nobody is
looking at.

### History (the branch graph)

Lane assignment lives in `menu/history-service.js`, in the *main process*,
deliberately: it can be tested in plain Node against a real repository and
compared with `git log --graph`. Graph layout bugs are near-impossible to
spot by eye in a UI. `history-service.toAscii()` renders the computed graph
as text for exactly that comparison.

The renderer (`client/history.js`) only draws what it is told - one small
SVG per row, so rows stay in normal document flow and line up with their
text without absolute positioning. `ROW_H` there must match
`.cgp-commit` height in the stylesheet.

Merge commits are drawn as hollow circles; lane colour is by column, so a
branch keeps its colour down the list.

This is the one view aimed at developers rather than analysts - a DAG with
merge commits is the mental model the rest of the plugin works to hide.

### Icons

`client/icons.js` uses the IBM Carbon set that Modeler exposes to plugins
on `window.vendor.carbonIconsReact`: the icons match Modeler's own and cost
nothing in the bundle. It is reached defensively - that global is not part
of the documented plugin API, so a version that stops exposing it degrades
to plain text glyphs rather than crashing the panel.

### Activity (the command log)

`menu/command-log.js` wraps the `simple-git` instance in a Proxy, so every
call is timed and recorded with its origin (`user` or `auto`). A Proxy is
used rather than simple-git's own `outputHandler` because that hook reports
the command but not whether it succeeded or how long it took.

The tab renders as a shell transcript - the one place in the plugin that
speaks git rather than translating it, because showing exactly what ran is
its whole purpose. Origins are async-local (`AsyncLocalStorage`), so a
background pull cannot mislabel a user action that overlaps it.

Each entry carries what the command *answered*, collapsed by default and
expanded automatically when it failed. An auto-pull that reported "Already
up to date" and one that merged four commits are the same line without it,
and that difference is usually what is being investigated.

### The git console

With **Developer mode** on (Git Settings, off by default, per-user rather
than per-project), the Activity tab grows a prompt. Typed commands run
against the configured repository and land in the same transcript as the
automatic ones, tagged `you` - so the log stays one honest account of what
happened rather than two.

`menu/git-console.js` is a **git runner, not a shell**. `git` is invoked
with an argv array, never through `sh`/`cmd`, so pipes, redirection, `&&`
and backticks are refused up front rather than silently ignored - which
also means a quoted commit message cannot be re-interpreted as syntax.
Arguments that escape the one boundary the plugin has (`-C`, `--git-dir`,
`--work-tree`, `--exec-path`, and `-c`, which reaches aliases and pagers)
are refused for the same reason.

It does *not* try to stop you damaging your own repository. Someone asking
for a console is asking for `reset --hard`; refusing it just sends them to
a terminal where this log cannot see it. This is also how the plugin
provides discard, amend, stash and rebase - deliberately absent as buttons,
available to anyone who turns the console on.

**Note on the threat model:** the bridge token is enough to keep other
pages out, but `client/dist/bridge.js` is readable by any process running
as this user, and with the console enabled that token grants arbitrary git
execution in the configured repo. That is a real widening over the
read-only routes, which is why it is opt-in and off by default.

### Auto-pull

Off by default. When on, it refuses to run unless *all* hold: enabled, a
remote exists, the working tree is completely clean, no merge is
half-finished, and no other plugin operation is in flight. A clean tree is
the important one - pulling into uncommitted work is how you get a
surprise conflict mid-edit. Blocked ticks report why, and the Settings tab
shows that reason rather than looking broken.

It never fires on startup (Modeler is usually still opening), and every
command it runs is tagged `auto` in Activity.

The explorer lists files via `git ls-files --cached --others
--exclude-standard`, so `.gitignore` is honoured for free and huge
directories are never walked. Clicking a diagram calls
`triggerAction('open-diagram', { path })` with an absolute path - the same
call Modeler's own file list makes.

Styling is a real stylesheet (`client/styles.css`) registered through the
`style` contribution point, not inline styles. Everything is scoped under
`.cgp-` and colours are CSS custom properties, so dark mode is one
override block rather than conditionals in JS.

`client/` is split: `index.js` owns the bridge and all state,
`components.js` holds the views.


| Where | What |
|---|---|
| Status bar (`status-bar__app`) | `⎇ main · 3 changes`. Click opens Source Control. |
| Bottom panel (`bottom-panel`) | "Source Control" tab: changed diagrams, one per row |

The client-facing wording is deliberately non-technical, because process
analysts use this too, not just developers:

- porcelain letters become words - `M` -> EDITED, `A` -> ADDED,
  `D` -> DELETED, `R` -> RENAMED, `?` -> NEW, colour-coded
- `.bpmn`/`.dmn`/`.form` extensions are stripped from the displayed name
- "no repository configured" becomes "No project folder selected yet",
  followed by the menu item that fixes it
- the raw path and the original git letter stay in each row's tooltip, so
  nothing is lost for developers

The status bar opens the panel with
`triggerAction('open-panel', { tab: 'source-control' })`, where the tab id
matches the `id` on the panel's own `Fill`. Both are rendered by the single
registered extension so they share one polling loop.

The panel is interactive. Files split into "Ready to save" (staged) and
"Changed" (unstaged); `+`/`−` move a file between them, "Add all" stages
everything, and the commit box creates a save point from what is staged.
"Get updates"/"Send" are pull/push, and show a count when you are
behind/ahead.

## Routines

Routines are the point of this plugin for non-technical users: one
task-level action in the team's own language, wrapping several git
commands. They live in `menu/routines.js` and follow two rules.

**Every routine can be previewed.** `plan()` describes what would happen
and changes nothing, so the panel can show "This will: 1. collect your 3
changed diagrams 2. create a save point 3. send it to the team" and wait
for confirmation. Preview and run are separate bridge routes so that
showing the plan can never accidentally execute it.

**Every routine leaves a recoverable state.** Local saving always happens
before any network step. If the push fails, the work is already committed
on the user's branch and the summary says so:

> Your work is saved safely on this computer, but it could not be sent to
> the team. Try "Get updates" and then send again - nothing is lost.

No routine force-pushes, discards, or resets. Nothing a routine does
should ever need an expert to undo.

Implemented: **Save my work** (collect -> save point -> send). The panel
shows it first and demotes the manual stage/commit/push controls to "Or do
it step by step".

## Error handling

Every error leaving the bridge goes through `menu/git-errors.js`, which
answers three questions in the reader's vocabulary: what happened, why,
and what to do now. Git's own text is precise and useless to a
non-technical reader - *"refusing to merge unrelated histories"* describes
a one-command fix that the reader has no way to guess.

| Git says | They see | Offered fix |
|---|---|---|
| refusing to merge unrelated histories | These two projects were started separately | Combine them anyway |
| need to specify how to reconcile divergent branches | You and the team both made changes | Combine both sets of changes |
| local changes would be overwritten | You have unsaved changes in the way | Save my work first, then get updates |
| failed to push / non-fast-forward | The team has newer changes | Get their updates now |
| could not resolve host | Cannot reach the team server | (none - explains it is a network issue) |
| authentication failed | The server did not accept your sign-in | (none - needs an administrator) |
| index.lock exists | Another operation is still running | (none - wait and retry) |

**A fix is only offered when applying it cannot lose work.** Each one
either creates a save point (which only adds history) or starts a merge
(which "Start over" can abort). None discards, resets, or force-pushes.
`save-then-pull` deliberately commits rather than stashes - a stash hides
work somewhere a non-technical user will never find it again.

Unrecognised errors keep their original text under a "Technical details"
disclosure rather than being hidden behind a vague message: an unfamiliar
error the user can paste to someone beats a friendly one that says
nothing.

## Workstreams (branches)

Branches are presented as **workstreams**. A branch is a developer concept
tied to a commit DAG; a workstream is "the thing I am working on", which is
what the reader actually has in their head. Same git objects, no graph, no
branch vocabulary.

`menu/naming.js` derives display names rather than storing them, because
keeping a name mapping in sync with real branches is more failure modes
than it is worth. A branch name carries three things and all three are
recovered by parsing:

```
feature/BDM-123456-invoice-approval-redesign
   |         |                |
  type    ticket            title      ->  "BDM-123456 · Invoice approval redesign"
```

The ticket stays *visible* in the display name on purpose. It is the part a
developer pastes into Jira, a build log or a standup, and a friendly name
that hides it just means looking the branch up again.

| Kind | Ticket | Starts from |
|---|---|---|
| New work (`feature/`) | required | everyday branch |
| Fix (`bugfix/`) | required | everyday branch |
| Urgent fix (`hotfix/`) | optional | **what is live** |

Hotfixes are the one case where the ticket is optional: requiring someone
to raise a ticket before they can start fixing a live outage is a rule that
gets broken rather than followed. They branch from the released line
because branching a hotfix off the integration branch is how unreleased
work reaches production by accident.

Ticket entry accepts `BDM-123456`, `bdm-123456`, a bare `123456`, or a
pasted Jira URL. Only the configured project key is accepted - `ABC-1`
matching would let a typo in the key through, and a branch named after a
ticket that does not exist is worse than one with no ticket at all. The
ticket is prefixed onto commit messages so `git log --oneline` stays
scannable, and skipped when the author already typed it.

The create form is built from rules sent by the main process rather than a
copy in the renderer, so what the UI enforces cannot drift from what the
branch name gets.

### Project settings (`.camunda-git.json`)

Two config files, split by who they belong to:

| File | Scope | Holds |
|---|---|---|
| `~/.camunda-git-plugin/config.json` | this person, this machine | open repo, tokens, auto-pull, developer mode |
| `<repo>/.camunda-git.json` | the team, committed | branch model, branch names, merge policy, Jira |

The split is the point. Analysts and developers work in the same repo, so
"which branch do features start from" cannot be a per-machine guess: two
people resolving it differently produces a branch layout nobody notices is
wrong until a merge. Anything that must agree lives in the committed file.

The local file is keyed by repository path. It used to be one flat object -
a single `mergePolicy` and `autoPull` for every project on the machine,
invisible to an analyst with one folder and wrong immediately for a
developer with five. `config-store.migrate()` moves that shape forward on
first read.

`menu/project-setup.js` writes the team file, and never automatically:
writing to someone's working tree as a side effect of opening a panel would
dirty a clean checkout at startup. It follows the same preview-then-apply
contract as the routines, refuses to name a branch that does not exist
(a committed file naming a missing branch makes *every* clone warn,
including the ones that were working), and deliberately does not stage or
commit - the Source Control panel shows it as a normal change to save.

Until that file exists, `resolveBranches()` falls back to guessing from
`MAIN_CANDIDATES` and reports `configured: false`, so the panel can say it
is guessing rather than implying the layout was chosen.

**Every switch saves first.** `saveWorkInProgress()` commits anything
uncommitted onto the branch it belongs to before checking out. "cannot
switch branch, you have local changes" is one of the most common ways a
non-technical user gets stuck, and it is entirely preventable rather than
something to explain afterwards. The UI reports what was auto-saved so it
never looks like work vanished.

New workstreams start from `origin/<main>` rather than the local copy, so
nobody unknowingly starts a week behind and finds out at merge time.

### Sending a workstream (and the upstream trap)

Branching from `origin/develop` makes git set the new branch's upstream to
**`origin/develop`** - that is `branch.autoSetupMerge`, on by default. A
workstream then reports itself as tracking the shared branch, and three
things follow:

- a plain `git push` fails with *"the upstream branch of your current
  branch does not match the name of your current branch"*
- ahead/behind counts in the status bar are measured against the wrong
  branch
- with `push.default = upstream`, a push writes the workstream **onto the
  shared branch** - no merge, no review, nothing to notice

So `createWorkstream()` passes `--no-track`: a workstream has no upstream
until it is first sent.

`publishCurrentBranch()` is the only way anything is pushed. It always uses
an explicit refspec, so the destination is never left to `push.default`,
and it never resolves a mismatch by pushing to whatever is tracked:

| Upstream | What it does |
|---|---|
| none | `push -u origin <branch>:<branch>` - publish and start tracking |
| same name | ordinary push to that branch |
| a long-lived branch | tracking is wrong; publish under this branch's own name and repoint |
| any other name | somebody set that up deliberately; push to it explicitly |

There is deliberately no push helper in `git-service.js`. Telling an
inherited upstream from a deliberate one needs to know which branches are
long-lived, and a convenience wrapper that trusts `status.tracking` is
precisely the mistake this section exists to describe.

Workstreams created before this was fixed are repaired on their next send,
and the translated error offers "Give it its own place on the server" for
anyone who hits it another way.

`pullCurrentBranch()` is the mirror image, for the same reasons. A plain
`git pull` needs an upstream, and there are three ordinary ways not to have
a usable one - never had one (`git push origin main` without `-u` leaves
the branch untracked), inherited the wrong one, or the workstream simply is
not on the server yet.

| Upstream | What it does |
|---|---|
| same name | ordinary pull from it |
| none or wrong, and the server has a branch of this name | pull from that and record the link |
| none or wrong, and it does not | say so - nothing is on the server to get |

The last row matters more than it reads. Git's own advice here is *"specify
which branch you want to merge with"*, which invites someone to pick the
shared branch and quietly merge it into their workstream. Doing nothing and
explaining why is the right answer.

Auto-pull takes the same path, so an untracked branch is a quiet no-op in
the background rather than an error that recurs every fifteen minutes.

**Note on placement:** Modeler 5.41.0 offers no right-side slot - the
right pane belongs to the bpmn-js properties panel. The five available
slots are `toolbar`, `status-bar__app`, `status-bar__file`, `tab-actions`,
`bottom-panel`. A docked git sidebar is not possible; a separate
BrowserWindow (as `ui/compare.html` uses) is the alternative when
something needs real space.

`mergePolicy` in Repository Settings (`review` | `direct`) records how
finished work should rejoin the shared version. Stored per project;
consumed by the finish routine once it exists.

## Conflicts

When two people change the same diagram, the panel switches entirely to
conflict resolution - offering "save my work" mid-merge is how people get
truly stuck.

**Resolution is file-level only, on purpose.** A `.bpmn` file is XML
describing a graph; a line-level three-way merge of two diagrams produces
something that is neither diagram and often is not valid XML. Nobody
hand-merges `<bpmn:sequenceFlow>` hunks. So the only choices are:

| Button | Effect |
|---|---|
| Combine both | Folds both sides into one diagram and stages it - only offered when the changes do not clash (see below) |
| Show me both | Opens both versions rendered side by side (`ui/compare.html`) |
| Keep mine | `checkout --ours` + stage |
| Keep the team's | `checkout --theirs` + stage |
| Finish | Commits the merge, using git's own MERGE_MSG |
| Start over | `merge --abort` - the escape hatch; committed work is untouched |

**"Combine both" is the answer to the lossy part of file-level resolution.**
When two people change the same diagram *without clashing* - one renames a
task, the other adds one, a third edits a different property of the same
element - keeping either whole side silently discards the other's work.
`diagram-diff-service.mergeXml` synthesises the union instead: it starts
from a fresh parse of your version (so your layout and edits are already
in place) and applies only what the analysis attributed to the other side
- their added elements and their layout, their removals, the properties
they changed.

It is **correct-or-abstain**. Every result is verified element-by-element
against what the clean merge must produce (`verifyMerge`); if the synthesis
missed anything - a deep extension-element edit it did not know how to fold
in - it returns `combinable: false` and the button is not offered, leaving
the keep-a-side flow untouched. A combine that might be wrong is worse than
no combine, because the entire reason it exists is that keep-a-side is lossy
in a way nobody notices. Combining is offered only when *nothing* clashes;
the moment any property is pulled two ways, the diagram is a keep-a-side
decision again.

Delete/modify conflicts are handled explicitly: `git checkout --ours` has
no blob to check out when one side deleted the file, so
`conflict-service.js` detects that case (`deletedBy`) and resolves with
add/rm instead. The UI says which side deleted it, because "keep theirs"
then means "accept the deletion".

**"Change my mind" undoes one decision.** `git checkout --merge -- <file>`
rebuilds the conflict from the index stages, which are still present until
the operation completes. Without it the only way back from a misclick is to
abort everything and redo every other file - enough of a cliff that people
press Finish on a resolution they know is wrong.

### It is not always a merge

The plugin only ever *starts* merges, but the console can leave a rebase,
cherry-pick or revert half-finished, and the recovery commands differ:

| In progress | Finish runs | Start over runs |
|---|---|---|
| merge | `commit` with the prepared message | `merge --abort` |
| rebase | `rebase --continue` | `rebase --abort` |
| cherry-pick | `cherry-pick --continue` | `cherry-pick --abort` |
| revert | `revert --continue` | `revert --abort` |

`operationInProgress()` decides which. Before this existed, "Start over"
during a rebase ran `git merge --abort` and failed with *"there is no merge
to abort"* - stranding the user at exactly the moment the escape hatch is
the entire point.

**A rebase inverts the sides.** Your commits are replayed *onto* the other
branch, so git's "ours" is that branch and "theirs" is your own work - the
opposite of a merge. This is the same hazard the branch-name labelling
already guards against, but worse: told "keep ours", someone discards their
own changes believing they kept them. `getMergeContext()` resolves the
sides per operation (from `rebase-merge/onto` and `head-name`) and sets
`inverted`, which the panel states out loud rather than leaving to be
inferred.

`--continue` needs an editor for the commit message and there is no
terminal behind the panel for git to open one in, so it passes
`-c core.editor=true`. simple-git refuses editor configuration by default -
correctly, since `core.editor` names a program to run - so this uses a
dedicated instance with `unsafe.allowUnsafeEditor`, scoped to that one call
rather than relaxed on the shared one.

`.git` is resolved through `gitDir()` rather than joined onto the repo
path, because it is a *file* pointing elsewhere in a worktree or submodule,
and every state file above is read out of it.

Being able to *see* both diagrams is the thing a generic Git client cannot
offer, and it is what makes file-level choice reasonable rather than a
guess.

Bridge routes: `GET /ping`, `GET /status`, and `POST` for `/stage`,
`/unstage`, `/stage-all`, `/commit`, `/push`, `/pull`,
`/routine/save/preview`, `/routine/save/run`. Mutating routes are
POST-only so no navigation or stray tag can trigger one, and each returns
the refreshed status so the panel updates in one round trip. File paths
are validated against traversal in `git-service.assertSafeRelativePath`
before reaching a git command.

The whole panel disables while an operation runs - git operations are not
safe to interleave, and a double-clicked commit is a real hazard.

**Not included:** discarding changes. Deleting someone's unsaved diagram
edits from a button is a bad idea, and `git checkout --` has no undo. Use
the menu or the command line deliberately if you need it.

### Available UI slots

Verified present in Modeler 5.41.0: `toolbar`, `status-bar__app`,
`status-bar__file`, `tab-actions`, `bottom-panel`. Bottom-panel fills take
`id`, `label`, `layout` and `priority` (Camunda's own panels use 5, 6 and
15).

### Building the client

`client/` is bundled by webpack into `client/dist/client.js`, which
`index.js` references via `script`. React is *not* bundled - it comes from
`window.react`, which Modeler binds before loading script plugins.

```sh
npm run build     # or: npm run watch
```

You must rebuild after changing anything in `client/`.

## How it's built

```
camunda-git-plugin/
  index.js            entry point (registers menu.js + the client bundle)
  webpack.config.js   builds client/ -> client/dist/client.js
  client/
    index.js           renderer extension: branch indicator in the status bar
  menu/
    bridge-server.js   loopback HTTP API the renderer half talks to
    menu.js            menu entries + all git/GitHub/GitLab/diff actions
    git-service.js      simple-git wrapper (status/diff/commit/push/pull)
    remote-service.js   parses origin URL, builds GitHub/GitLab URLs, calls their REST APIs
    config-store.js     tiny JSON config file in ~/.camunda-git-plugin/config.json
    windows.js           opens the small BrowserWindows below over a namespaced IPC channel
  ui/
    preload.js           exposes window.gitPlugin.invoke(...) to each window
    status.html/.js       git status/diff/commit/push/pull panel
    issues.html/.js        GitHub/GitLab open-issues list
    diagram-diff.html/.js  bpmn-js rendering + diff highlighting (bpmn-js loaded from local node_modules - works offline)
```

## Notes / limitations

- This is a hobby-scale scaffold, not a hardened tool: no retry/offline
  handling, tokens are stored in plaintext at
  `~/.camunda-git-plugin/config.json`, and diff/status output is
  read-only (no per-hunk staging).
- The diagram-diff view renders with `bpmn-js`, loaded from the local
  `node_modules` copy (pinned to an exact version in `package.json`), so
  it works with no internet connection. This means `npm install` is
  required before the diff view will work - see Install above.
- Everything after "Repository Settings" assumes a remote named
  `origin`.
