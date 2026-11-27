---- MODULE Triggers ----
EXTENDS Naturals

CONSTANT N
VARIABLES tick, matching, created
vars == <<tick, matching, created>>
Ids == 1..N
Keys == {"scheduled", "message"} \X Ids

Init == /\ tick = 0 /\ matching = {} /\ created = [k \in Keys |-> 0]
ClockTicks == /\ tick < N /\ tick' = tick + 1 /\ UNCHANGED <<matching, created>>
MessageArrives(id) == /\ id \notin matching /\ matching' = matching \cup {id} /\ UNCHANGED <<tick, created>>
OtherThreadOrOutbound == UNCHANGED vars
Eligible(key) == IF key[1] = "scheduled" THEN key[2] <= tick ELSE key[2] \in matching
AdmitOccurrence(key) ==
  /\ Eligible(key) /\ created[key] = 0
  /\ created' = [created EXCEPT ![key] = @ + 1]
  /\ UNCHANGED <<tick, matching>>
ReplayOccurrence(key) == /\ created[key] > 0 /\ UNCHANGED vars

Next ==
  \/ ClockTicks \/ OtherThreadOrOutbound
  \/ \E id \in Ids : MessageArrives(id)
  \/ \E key \in Keys : AdmitOccurrence(key) \/ ReplayOccurrence(key)
Spec == Init /\ [][Next]_vars

TypeOK == /\ tick \in 0..N /\ matching \subseteq Ids /\ created \in [Keys -> Nat]
AtMostOneTaskPerOccurrence == \A k \in Keys : created[k] <= 1
OnlyEligibleOccurrencesCreateTasks == \A k \in Keys : created[k] > 0 => Eligible(k)
RememberAdmitted == \A k \in Keys : created'[k] >= created[k]
StableKeys == [][RememberAdmitted]_vars
====
