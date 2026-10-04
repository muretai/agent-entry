#!/usr/bin/env python3
"""Check the appl-splitter's answer before anything is filed from it.

    <splitter output> | python3 appl-split-check.py

The splitter (.claude/agents/appl-splitter.md) is a model; its answer is DATA, never
instructions and never run. This reads it on stdin and accepts exactly one of two shapes:

    ONE

alone (the requirement fits one pair: brief it whole), or 1 to 6 item lines, each exactly
five fields joined by ` | `:

    <title> | <requirement> | after: <title of an earlier item, or none> | class: <skeleton|polish> | priority: <P0|P1|P2|P3>

  title        non-empty, no colon, no control character, no leading or trailing blank,
               at most 120 characters, not the title of another item
  requirement  one or two sentences, each ending at `.`, `!` or `?`
  after        `none`, or the title of an item ABOVE this one in the same answer
  class        `skeleton` or `polish`, exactly
  priority     `P0`, `P1`, `P2` or `P3`, exactly

Accepted: exit 0, and stdout is the input lines byte for byte (each with a final
newline), so the coordinator files from this output and nothing else. Refused: exit 1, one
reason on stderr, NOTHING on stdout -- nothing is filed from a refused answer.

Stdlib only. Python 3.9+. ASCII-only source.
"""

import re
import sys

MAX_ITEMS = 6
TITLE_MAX = 120
SEP = " | "
CLASSES = ("skeleton", "polish")
PRIORITIES = ("P0", "P1", "P2", "P3")
# a sentence ends at . ! or ? followed by a blank or the end of the requirement
SENTENCE_END = re.compile(r"[.!?]+(?=\s|$)")


class Refused(Exception):
    pass


def control(s):
    """a character a reader could split a line on or a terminal could act on"""
    return any(ord(c) < 0x20 or 0x7f <= ord(c) < 0xa0 or len(("x" + c + "x").splitlines()) > 1
               for c in s)


def keyed(field, key, n):
    """the value of `<key>: <value>`, or a refusal naming item n"""
    prefix = key + ": "
    if not field.startswith(prefix) or field[len(prefix):] == "":
        raise Refused("item %d: the %s field is not `%s<value>`" % (n, key, prefix))
    return field[len(prefix):]


def check_item(line, n, titles):
    fields = line.split(SEP)
    if len(fields) != 5:
        raise Refused("item %d: %d fields, not the five joined by ` | `" % (n, len(fields)))
    title, req, after, cls, pri = fields
    if title.strip() == "" or title != title.strip():
        raise Refused("item %d: the title is empty or has a leading or trailing blank" % n)
    if ":" in title:
        raise Refused("item %d: the title holds a colon" % n)
    if len(title) > TITLE_MAX:
        raise Refused("item %d: the title is over %d characters" % (n, TITLE_MAX))
    if title in titles:
        raise Refused("item %d: the title repeats an earlier item's" % n)
    if req.strip() == "" or req != req.strip():
        raise Refused("item %d: the requirement is empty or has a leading or trailing blank" % n)
    if not req.endswith((".", "!", "?")):
        raise Refused("item %d: the requirement does not end a sentence" % n)
    sentences = len(SENTENCE_END.findall(req))
    if not 1 <= sentences <= 2:
        raise Refused("item %d: the requirement is %d sentences, not one or two" % (n, sentences))
    a = keyed(after, "after", n)
    if a != "none" and a not in titles:
        raise Refused("item %d: `after: %s` names no item above it" % (n, a))
    if keyed(cls, "class", n) not in CLASSES:
        raise Refused("item %d: the class is not skeleton or polish" % n)
    if keyed(pri, "priority", n) not in PRIORITIES:
        raise Refused("item %d: the priority is not P0, P1, P2 or P3" % n)
    return title


def check(data):
    """the accepted lines, or Refused"""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("the answer is not UTF-8")
    if text.endswith("\n"):
        text = text[:-1]
    if text == "":
        raise Refused("the answer is empty")
    lines = text.split("\n")
    for n, ln in enumerate(lines, 1):
        if control(ln):
            raise Refused("line %d holds a control character" % n)
    if lines == ["ONE"]:
        return lines
    if "ONE" in lines:
        raise Refused("`ONE` is an answer alone, never beside another line")
    if len(lines) > MAX_ITEMS:
        raise Refused("%d items; a split is at most %d" % (len(lines), MAX_ITEMS))
    titles = []
    for n, ln in enumerate(lines, 1):
        titles.append(check_item(ln, n, titles))
    return lines


def main():
    try:
        lines = check(sys.stdin.buffer.read())
    except Refused as e:
        sys.stderr.write("appl-split-check: refused: %s; nothing may be filed from it\n" % e)
        return 1
    sys.stdout.buffer.write("".join(ln + "\n" for ln in lines).encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
