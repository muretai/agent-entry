#!/usr/bin/env python3
"""Translate one Claude-spelled allow or deny rule into Grok's --allow / --deny text.

The spelling is the one measured on this machine, written up in
notes/grok-rule-spelling.md. A shape that measurement does not settle is refused
by name. This module never runs grok and never reads or writes ~/.grok.

    grok_rule(rule) -> str
    grok_argv(allow, deny) -> list
    GrokRuleRefused

    python3 -I grok_rules.py <rules.json>

rules.json is {"permissions": {"allow": [...], "deny": [...]}}. Success writes the
argv to stdout, each entry NUL-terminated. A refusal exits non-zero, writes nothing
on stdout, and prints one line on stderr.
"""

from __future__ import annotations

import json
import sys

# Path tools whose Claude absolute form is Tool(//abs). Grok treats a leading //
# as literal glob text, so the absolute form is one leading slash. Write is the
# same tool class as Edit in grok's guide, and this translation never emits Write.
_ABS_TOOLS = ("Edit", "Read", "Grep", "Glob", "Write")

# Tool names the guide lists as recognized, besides Bash. A rule in one of these
# shapes is already grok's spelling and is passed through.
_NAMED_TOOLS = ("Read", "Edit", "Grep", "Glob", "WebFetch", "WebSearch", "MCPTool")


class GrokRuleRefused(Exception):
    """Raised when a rule cannot be expressed as one grok argv value."""


def _refuse(rule, reason):
    shown = json.dumps(rule, ensure_ascii=True) if isinstance(rule, str) else json.dumps(str(rule))
    raise GrokRuleRefused("grok refuses " + shown + ": " + reason)


def _controls(text):
    return any(ord(c) < 0x20 or ord(c) == 0x7F for c in text)


def _checked(out, rule):
    if out == "" or out.startswith("-") or _controls(out):
        _refuse(rule, "the grok spelling is not one argv value")
    return out


def grok_rule(rule):
    """One Claude-spelled rule, in the grok spelling the measurement settled."""
    if not isinstance(rule, str):
        _refuse(rule, "not a string rule")
    if rule == "":
        _refuse(rule, "an empty rule")
    if _controls(rule):
        _refuse(rule, "a rule value cannot carry a control character")
    if rule == "Bash()":
        _refuse(rule, "an empty Bash body")

    if rule.startswith("Bash(") and rule.endswith(")"):
        body = rule[len("Bash("):-1]
        if body == "":
            _refuse(rule, "an empty Bash body")
        # Claude's trailing :* is the prefix and then a space. Grok strips :* to a
        # prefix with no word boundary, so the measured whole-word form is a space
        # and then a star: Bash(git *).
        if body.endswith(":*"):
            return _checked("Bash(" + body[:-2] + " *)", rule)
        return _checked(rule, rule)

    for tool in _ABS_TOOLS:
        lead = tool + "(//"
        if rule.startswith(lead) and rule.endswith(")"):
            inner = rule[len(lead):-1]
            if inner == "":
                _refuse(rule, "an empty absolute path")
            dest = "Edit" if tool == "Write" else tool
            return _checked(dest + "(/" + inner + ")", rule)

    if rule in _NAMED_TOOLS:
        return rule

    for tool in _NAMED_TOOLS:
        if rule.startswith(tool + "(") and rule.endswith(")"):
            return _checked(rule, rule)

    if rule.startswith("Write(") and rule.endswith(")"):
        return _checked("Edit(" + rule[len("Write("):], rule)

    _refuse(rule, "no measured grok spelling for this shape")


def _deny_values(rule):
    """The grok values for one Claude deny. Claude's Bash(x:*) also matches the bare
    command x, and grok's Bash(x *) does not, so a :* deny is the bare Bash(x) first
    and then Bash(x *). An empty prefix keeps its one value, as before."""
    value = grok_rule(rule)
    if rule.startswith("Bash(") and rule.endswith(":*)"):
        prefix = rule[len("Bash("):-len(":*)")]
        if prefix != "":
            return [_checked("Bash(" + prefix + ")", rule), value]
    return [value]


def grok_argv(allow, deny):
    """["--allow", r, ..., "--deny", r, ...]. A refused rule refuses the whole list.
    Deny values are emitted once each, at their first place."""
    out = []
    for rule in allow:
        out.append("--allow")
        out.append(grok_rule(rule))
    seen = set()
    for rule in deny:
        for value in _deny_values(rule):
            if value in seen:
                continue
            seen.add(value)
            out.append("--deny")
            out.append(value)
    return out


def main(argv):
    if len(argv) != 1:
        print("grok refuses a rules file: expected one path", file=sys.stderr)
        return 2
    path = argv[0]
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print("grok refuses " + json.dumps(path) + ": " + type(exc).__name__, file=sys.stderr)
        return 2
    if not isinstance(data, dict) or not isinstance(data.get("permissions"), dict):
        print("grok refuses " + json.dumps(path) + ": no permissions object", file=sys.stderr)
        return 2
    perms = data["permissions"]
    allow = perms.get("allow", [])
    deny = perms.get("deny", [])
    if not isinstance(allow, list) or not isinstance(deny, list):
        print("grok refuses " + json.dumps(path) + ": allow and deny must be lists", file=sys.stderr)
        return 2
    try:
        out = grok_argv(allow, deny)
    except GrokRuleRefused as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if out:
        sys.stdout.write("\0".join(out) + "\0")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
