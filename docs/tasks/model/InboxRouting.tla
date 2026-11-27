---- MODULE InboxRouting ----
VARIABLES origin, kind, item, notice, responseVia
vars == <<origin, kind, item, notice, responseVia>>
Origins == {"web", "thread X", "thread Y"}
Blocking == {"question", "report"}
Init == /\ origin \in Origins /\ kind = "none" /\ item = "none"
        /\ notice = "none" /\ responseVia = "none"

Publish(k) ==
  /\ kind = "none" /\ kind' = k
  /\ item' = IF k \in Blocking THEN "open" ELSE "none"
  /\ notice' = "pending"
  /\ UNCHANGED <<origin, responseVia>>

SurfaceInOrigin(destination) ==
  /\ notice = "pending" /\ destination = origin
  /\ notice' = destination /\ UNCHANGED <<origin, kind, item, responseVia>>

Respond(channel) ==
  /\ item = "open" /\ channel = "web"
  /\ item' = "answered" /\ responseVia' = channel /\ UNCHANGED <<origin, kind, notice>>

Quiet == /\ kind # "none" /\ UNCHANGED vars
Next ==
  \/ \E k \in Blocking \cup {"progress"} : Publish(k)
  \/ \E destination \in Origins : SurfaceInOrigin(destination)
  \/ \E channel \in Origins : Respond(channel)
  \/ Quiet
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ origin \in Origins /\ kind \in Blocking \cup {"none", "progress"}
  /\ item \in {"none", "open", "answered"} /\ notice \in Origins \cup {"none", "pending"}
  /\ responseVia \in Origins \cup {"none"}
OnlyQuestionsAndReportsNeedInput == (kind \in Blocking) = (item # "none")
InboxIsAuthoritative == IF item = "answered" THEN responseVia = "web" ELSE responseVia = "none"
NotifyInOriginOnly == notice \in {"none", "pending", origin}
InboxItemAndNoticeCreatedTogether == (kind = "none") = (notice = "none")
====
