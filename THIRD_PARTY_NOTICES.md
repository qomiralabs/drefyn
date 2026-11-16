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

## nodemailer

Licence: MIT-0

Nodemailer by Andris Reinman and contributors (https://github.com/nodemailer/nodemailer),
used as the SMTP client of `@drefyn/email`. MIT No Attribution: it may be used, changed and
shipped without keeping a notice. Listed here because the licence policy names every
shipped package outside its allow list.

## lean-qr

Licence: MIT

lean-qr 2.7.4 by David Evans (https://github.com/davidje13/lean-qr). Copyright (c) 2021-2025
David Evans. MIT is on the allow list, so no entry is required; it is listed because the
dashboard draws authenticator QR codes with it on the server. It has no dependencies, and
nothing from it is sent to browsers: the dashboard writes the matrix into its own SVG path.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions: The above copyright
notice and this permission notice shall be included in all copies or substantial portions of
the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED.
