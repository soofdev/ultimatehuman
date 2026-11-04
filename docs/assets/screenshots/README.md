# Documentation screenshots

These images use fictional Acme repositories, sample messages, findings, and run states. They contain no customer projects, credentials, or production data.

| File | Content | Capture |
| --- | --- | --- |
| `chat.png` | Project setup and next steps | Shipped `0.1.0` UI, seeded conversation |
| `pipeline-live.png` | An investigation and prepared findings | Shipped `0.1.0` UI, seeded runs |
| `review.png` | A checkout finding with two screenshot attachments | Original Review components, fixture attachments |
| `review-evidence.png` | The first attachment in the full-screen viewer | Opened through the original Review thumbnail |
| `checkout-failure.png` | A valid ZIP code rejected at checkout | Browser capture of a local demo form |
| `checkout-request.png` | The request and validation error | Browser capture of the demo's recorded request |

## Review example

The local demo deliberately converts the ZIP code `02108` to the number `2108` before sending it. The validator rejects that request with HTTP `400`. Sending the original string `"02108"` to the same validator succeeds with HTTP `201`. No payment is taken.

Both evidence images were captured in Chrome and supplied as fixture attachments to the existing Review components. The screenshot viewer itself is unchanged. Both images loaded at their original resolution; opening a thumbnail, moving between images with the arrow keys, and closing with Escape were checked.

This is an illustrative review, not a pipeline result from a customer application. The fixture supplies the attachments during ticket serialization and serves their image requests in the isolated browser session. No production data adapter, collector, or application behavior was changed to make these screenshots.

Version `0.1.0` currently maps finding evidence to an empty screenshot list. It does not connect screenshot attachments to these Review components or automatically capture screenshots. The root README states this next to the example. Do not describe the images as proof that an installed `0.1.0` pipeline automatically reproduces bugs, captures screenshots, implements fixes, or merges changes.
