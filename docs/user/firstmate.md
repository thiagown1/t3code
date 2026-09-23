# FirstMate

FirstMate is an orchestrator you talk to instead of managing threads by hand. It
splits a request into **topics**, hands each topic to its own thread, and brings
work back to you as **decisions**: a question, the options, and its
recommendation. You answer by picking an option.

## Start a supervisor thread

FirstMate needs one thread per project to plan in. Open the thread you want to
use and run **Use this thread as FirstMate supervisor** from the command palette.
The **FirstMate** section in the sidebar then names that thread at the top of the
topic list.

From that thread, the agent creates topics, delegates them to worker threads, and
opens decisions. Messages you send in the supervisor thread are routed to the
thread that owns the active topic instead of being answered there; FirstMate asks
which topic you meant when it cannot tell.

To stop, use the unlink button beside the supervisor row in the sidebar, or run
**Stop using this thread as FirstMate supervisor**. Linking a different thread
replaces the old one. Topics and decisions are untouched either way.

## Answer decisions

Pending decisions appear as cards above the composer in the supervisor thread,
blocking ones first. Choosing an option records your answer against the topic.
**Dismiss without deciding** cancels a decision you do not want to answer.

The **Decisions** section of the sidebar shows the same pending decisions across
every project you have open, so you can answer without opening each supervisor
thread.

Approvals and questions raised by the worker threads themselves show up in the
same place. When a thread a topic was delegated to asks to run a command or
picks between answers, that question becomes a decision card, and answering it
here answers it in that thread — the thread carries on without you opening it.
Answering in the thread instead removes the card. Dismissing a card leaves the
question for you to answer in its own thread, and it will not come back to the
inbox. Some questions stay in their thread regardless, such as forms with
several questions or ones where you can pick more than one answer.

## Review finished turns

Agents often stop without asking anything: they report success, stop with work
left, or ask a question in plain text. Turn on **Settings → New threads →
FirstMate turn review** to have a cheap judge read every finished turn in a
FirstMate project and act on it:

- work that is clearly finished is marked **Done** (sending the thread a new
  message reopens it);
- work that clearly has more to do inside the original request gets a short
  "continue" message, at most five times in a row;
- anything else becomes a decision card with **Continue as proposed**, **Mark
  done**, and **I'll answer in the thread**.

Pick **Jev (OpenRouter)** and set an OpenRouter API key in the row below it, or
pick **Cheap model** to use a model from your providers. The key stays on the
server; settings only show whether one is set.

## Follow topics

The **FirstMate** section lists every topic with its stage, the agent
responsible, any linked pull requests, and how many decisions are waiting.
Selecting a topic with the target icon makes it the destination for your next
supervisor message. Opening a topic row jumps to the thread doing that work.

A topic's status is derived, not asserted: it reflects the delegated thread's
session, pending questions, and pull request checks. FirstMate never merges,
deploys, or activates anything on its own.
