#!/usr/bin/env bash
# Answer an APPL intake that came in by mail: send the reply to the peer that wrote it,
# then record `status: answered #<mail-id>` on the intake.
#
#   appl-answer.sh <intake file> "<reply>"
#
# The intake is one appl-hook.sh filed on the coordinator's mail wake (tools/appl-add.sh
# --from mail:<peer> --mail-id <id>). It must be a regular file (not a symlink) directly
# under $HERD_DIR/coordinator/intake/ (HERD_DIR defaults to ~/.cache/muretai-herd). Only
# its HEADER -- the lines before the first blank line -- is read: `mail-did: <did>` is
# who the reply goes to (the signer's DID, which appl-hook.sh took from the inbox row's
# peer_did), `mail-id: <digits>` the message it answers, and `from: mail:<peer>` only
# marks the intake as mail. `from:` is a DISPLAY name a sender can forge through an
# unsigned metadata.group overlay, so it is never a destination: a forged contact label
# or DID prefix would otherwise route the reply to a third party (security review
# 2026-09-28, finding 3). The `## Task` below is a peer's text, so any header-looking
# line inside it is data, never a field.
#
# The reply is sent as the identity that received the mail, the header's `mail-as:` that
# appl-hook.sh wrote from the inbox it read (never `from:`, never the body):
#   $APPL_OPERATOR_CLI --as <mail-as> dm -- <mail-did> <reply>
# That identity must be one agent name in the machine file's `[coordinator]` `identities`
# (read by coordinator_identities.py beside this script, and only that file:
# $APPL_MACHINE_CONFIG, else ~/.config/appl/machine.toml); with no machine file or no
# `[coordinator]` table the one identity is dispatch-mac-a, as the hook then reads only
# that inbox. An absent or unreadable reader is refused by name and nothing is sent.
# (APPL_OPERATOR_CLI unset: the front door, `muretai op`, never an interpreter and a
# path -- the seat's permissions name `muretai op`, and the interpreter spelling sits in
# the family the deny list refuses by shape). The DID and the reply
# each travel as ONE argv element, never through a shell. Only when the send exits 0 is
# the status set, through appl-status.sh (which logs `status <intake>`); the reply text
# never reaches the header or the log.
#
# Refusals, each a non-zero exit with one stderr line, nothing sent and nothing written:
# usage (exit 2); a path that is not such an intake; a header with no `from: mail:<peer>`,
# or whose `mail-id:` is not one decimal number; a header with no `mail-did:`, or one that
# is empty or not one DID-shaped word; a header with no `mail-as:`, or one that is empty,
# not one agent name, or not an identity the machine file lists; an empty reply. A failed send is exit 1
# with the intake byte-identical, so the item stays open and can be answered again.
#
# This is the coordinator's reply path for M2 "intake by mail" (plan 2026-09-19,
# multi-Mac): the hook files inbound mail and never sends; this script sends and files
# nothing.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
herd="${HERD_DIR:-${HOME:-}/.cache/muretai-herd}"
DISPATCH="dispatch-mac-a"

if [ $# -ne 2 ]; then
  echo "usage: appl-answer.sh <intake file> \"<reply>\"" >&2
  exit 2
fi
intake=$1
reply=$2

# The header fields, checked: prints `<identity>`, `<signer DID>` then `<mail-id>` (one per
# line) or refuses.
fields=$(python3 -I - "${herd%/}/coordinator" "$intake" "$reply" "$here/coordinator_identities.py" "$DISPATCH" <<'PY'
import os, re, sys, types

coord, intake, reply, reader, default = sys.argv[1:6]


def refuse(why):
    print("appl-answer: " + why + "; nothing was sent", file=sys.stderr)
    sys.exit(1)


if not reply.strip():
    refuse("the reply is empty")
intake_dir = os.path.join(coord, "intake")
base = os.path.basename(intake)
if not intake.startswith("/"):
    refuse("the intake is named by an absolute path")
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,124}\.md", base):
    refuse("not an intake file name")
if not os.path.isdir(intake_dir) or os.path.realpath(os.path.dirname(intake)) != os.path.realpath(intake_dir):
    refuse("not a file directly under " + intake_dir)
if os.path.islink(intake) or not os.path.isfile(intake):
    refuse("no intake file there (or a symlink)")
with open(intake, encoding="utf-8", errors="replace") as f:
    text = f.read(1 << 20)
peer = mail_id = did = ident = None
for ln in text.split("\n"):
    if ln == "":
        break
    if ln.startswith("from:") and peer is None:
        peer = ln[len("from:"):].strip()
    elif ln.startswith("mail-id:") and mail_id is None:
        mail_id = ln[len("mail-id:"):].strip()
    elif ln.startswith("mail-did:") and did is None:
        did = ln[len("mail-did:"):].strip()
    elif ln.startswith("mail-as:") and ident is None:
        ident = ln[len("mail-as:"):].strip()
if not peer or not peer.startswith("mail:") or not peer[len("mail:"):].strip():
    refuse("the intake did not come from mail (its header has no `from: mail:<peer>`)")
if mail_id is None or not re.fullmatch(r"[0-9]{1,18}", mail_id):
    refuse("the header `mail-id:` is not one decimal number")
# the SIGNER, as appl-hook.sh recorded it; `from:` is a display name and is never a
# destination (security review 2026-09-28, finding 3)
if did is None or not re.fullmatch(r"did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,256}", did):
    refuse("the header has no `mail-did:` naming the signer's DID; a reply never goes to a name")
# the RECEIVING identity, as appl-hook.sh recorded it from the inbox it read
if ident is None or not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", ident):
    refuse("the header has no `mail-as:` naming one receiving identity")
# the identities reader beside this script, by absolute path and compiled from its source,
# never a module of the repository: <repo>/tools is not guarded, and in a consumer it is
# the consumer's own (ISSUE(security-audit-2026-10-27-pin-the-coordinator-2468)). Absent,
# unreadable or broken: refused by name, never a fallback to the default identity.
try:
    if os.path.islink(reader) or not os.path.isfile(reader):
        raise OSError("not a regular file")
    mod = types.ModuleType("coordinator_identities")
    mod.__file__ = reader
    with open(reader, "rb") as f:
        exec(compile(f.read(), reader, "exec"), mod.__dict__)
    listed = mod.read_coordinator_identities()
except Exception as e:
    refuse("the identities reader coordinator_identities.py is absent or unreadable ("
           + reader + ": " + type(e).__name__ + ")")
if ident not in ([default] if listed is None else listed):
    refuse("the header `mail-as:` is not an identity the machine file lists")
print(ident)
print(did)
print(mail_id)
PY
) || exit 1
as_id=${fields%%$'\n'*}
rest=${fields#*$'\n'}
did=${rest%$'\n'*}
mail_id=${rest##*$'\n'}

if [ -n "${APPL_OPERATOR_CLI:-}" ]; then
  "$APPL_OPERATOR_CLI" --as "$as_id" dm -- "$did" "$reply" </dev/null >/dev/null
else
  muretai op --as "$as_id" dm -- "$did" "$reply" </dev/null >/dev/null
fi
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "appl-answer: the send to $did failed (exit $rc); the intake is unchanged" >&2
  exit 1
fi

if ! bash "$here/appl-status.sh" "$intake" "answered #$mail_id"; then
  echo "appl-answer: the reply WAS sent, but the status could not be set; set it with appl-status.sh <intake> \"answered #$mail_id\"" >&2
  exit 1
fi
exit 0
