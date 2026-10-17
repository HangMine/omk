# Status Metadata Review Feedback

Reviewer: current root agent, direct metadata review, not an independent external review.

Observed by `accept --diagnose`: WP01 is in_progress but canonical runtime state lacks assignee and shell_pid. Repeating in_progress is an illegal transition. The installed CLI requires an explicit feedback file for a backward planned transition.

Required correction: return WP01 to planned under this feedback reference, then use the normal planned→doing transition to capture the actual current caller attribution. No force option, skip flag or fabricated approval is allowed. The source and compiled operating evidence remain valid; this rejection addresses status metadata only.

Also remap project path conventions to the existing packages/coding-agent source/test/docs directories through the supported project.path_conventions setting. Preserve the mandatory mission contracts surface and the acceptance verdict evidence. Do not create empty src/tests/docs directories or use lenient acceptance.
