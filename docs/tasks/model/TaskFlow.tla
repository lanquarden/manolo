---- MODULE TaskFlow ----
EXTENDS Naturals

CONSTANT MaxRounds
VARIABLES phase, due, holdsSlot, epoch, opened, answered, item, dep, follower, publishedEpoch
vars == <<phase, due, holdsSlot, epoch, opened, answered, item, dep, follower, publishedEpoch>>
terminal == {"completed", "failed", "cancelled"}
active == {"queued", "running", "waiting"}

Init ==
  /\ phase = "absent" /\ due = FALSE /\ holdsSlot = FALSE /\ epoch = 0
  /\ opened = 0 /\ answered = 0 /\ item = "none"
  /\ dep \in {"success", "terminal"} /\ follower = "queued" /\ publishedEpoch = 0

CreateTask(now) ==
  /\ phase = "absent" /\ phase' = "queued" /\ due' = now
  /\ UNCHANGED <<holdsSlot, epoch, opened, answered, item, dep, follower, publishedEpoch>>

TimeArrives ==
  /\ phase = "queued" /\ ~due /\ due' = TRUE
  /\ UNCHANGED <<phase, holdsSlot, epoch, opened, answered, item, dep, follower, publishedEpoch>>

Claim ==
  /\ phase = "queued" /\ due /\ ~holdsSlot
  /\ phase' = "running" /\ holdsSlot' = TRUE /\ epoch' = epoch + 1
  /\ UNCHANGED <<due, opened, answered, item, dep, follower, publishedEpoch>>

AskForInput(kind) ==
  /\ phase = "running" /\ opened < MaxRounds
  /\ phase' = "waiting" /\ holdsSlot' = FALSE
  /\ opened' = opened + 1 /\ item' = kind
  /\ UNCHANGED <<due, epoch, answered, dep, follower, publishedEpoch>>

Respond(round) ==
  /\ phase = "waiting" /\ round = opened /\ item # "none"
  /\ phase' = "queued" /\ answered' = answered + 1 /\ item' = "none"
  /\ UNCHANGED <<due, holdsSlot, epoch, opened, dep, follower, publishedEpoch>>

ReplayResponse(round) ==
  /\ round <= answered /\ UNCHANGED vars

Finish(run, outcome) ==
  /\ phase = "running" /\ run = epoch
  /\ phase' = outcome /\ holdsSlot' = FALSE /\ publishedEpoch' = run
  /\ UNCHANGED <<due, epoch, opened, answered, item, dep, follower>>

IgnoreOldResult(run) ==
  /\ run <= epoch /\ (phase # "running" \/ run # epoch)
  /\ UNCHANGED vars

Cancel ==
  /\ phase \in active /\ phase' = "cancelled"
  /\ holdsSlot' = FALSE /\ item' = "none"
  /\ UNCHANGED <<due, epoch, opened, answered, dep, follower, publishedEpoch>>

StartFollower ==
  /\ follower = "queued"
  /\ (phase = "completed" \/ (dep = "terminal" /\ phase \in terminal))
  /\ follower' = "started"
  /\ UNCHANGED <<phase, due, holdsSlot, epoch, opened, answered, item, dep, publishedEpoch>>

Rest ==
  /\ phase \in terminal \cup {"waiting"} /\ UNCHANGED vars

Next ==
  \/ \E now \in BOOLEAN : CreateTask(now)
  \/ TimeArrives \/ Claim
  \/ \E kind \in {"question", "report"} : AskForInput(kind)
  \/ \E round \in 1..MaxRounds : Respond(round) \/ ReplayResponse(round)
  \/ \E run \in 1..(MaxRounds + 1) : (\E outcome \in {"completed", "failed"} : Finish(run, outcome)) \/ IgnoreOldResult(run)
  \/ Cancel \/ StartFollower \/ Rest

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in active \cup terminal \cup {"absent"} /\ due \in BOOLEAN /\ holdsSlot \in BOOLEAN
  /\ epoch \in 0..(MaxRounds + 1) /\ opened \in 0..MaxRounds /\ answered \in 0..MaxRounds
  /\ item \in {"none", "question", "report"} /\ dep \in {"success", "terminal"}
  /\ follower \in {"queued", "started"}
SlotOnlyWhileRunning == holdsSlot = (phase = "running")
NoEarlyClaim == epoch > 0 => due
OneOpenItemOnlyWhileWaiting ==
  /\ (item # "none") = (phase = "waiting")
  /\ answered <= opened
  /\ phase = "waiting" => opened = answered + 1
NoExtraRuns ==
  /\ epoch <= answered + 1
  /\ phase = "queued" => epoch = answered
FollowerNeedsOutcome ==
  follower = "started" => phase = "completed" \/ (dep = "terminal" /\ phase \in terminal)
KeepTerminal == phase \in terminal => (phase' = phase)
TerminalIsFinal == [][KeepTerminal]_vars
OnlyCurrentClaimCanSetOutcome ==
  IF phase \in {"completed", "failed"} THEN publishedEpoch = epoch /\ publishedEpoch > 0
  ELSE publishedEpoch = 0
====
