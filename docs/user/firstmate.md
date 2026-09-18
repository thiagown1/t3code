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

## Follow topics

The **FirstMate** section lists every topic with its stage, the agent
responsible, any linked pull requests, and how many decisions are waiting.
Selecting a topic with the target icon makes it the destination for your next
supervisor message. Opening a topic row jumps to the thread doing that work.

A topic's status is derived, not asserted: it reflects the delegated thread's
session, pending questions, and pull request checks. FirstMate never merges,
deploys, or activates anything on its own.
