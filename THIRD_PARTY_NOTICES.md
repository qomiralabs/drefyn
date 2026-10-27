# Third party notices

Drefyn is licensed under Apache 2.0. Almost every package it ships is under a permissive
licence on the allow list in `scripts/license-policy/policy.json`. The packages below ship
under another licence that the policy accepts by exception, and each one carries the notice
its licence asks for. The licence check fails if a shipped exception has no entry here.

## caniuse-lite

Licence: CC-BY-4.0

Browser support data from Can I Use (https://caniuse.com) by Alexis Deveria, packaged as
caniuse-lite by Ben Briggs and the Browserslist contributors
(https://github.com/browserslist/caniuse-lite). Licensed under the Creative Commons
Attribution 4.0 International licence: https://creativecommons.org/licenses/by/4.0/

Next.js reads this data through browserslist when it builds the dashboard. Drefyn does not
modify it, and it is not sent to browsers.
