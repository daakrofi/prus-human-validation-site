# PRUS Human Validation Site

This repository contains the GitHub Pages website for post-level human validation of Pre-Release User Speculation (PRUS).

## Validation Unit

The unit presented to coders is a Steam topic-root post, represented by the post title and the captured post body/excerpt retained in the analysis corpus. This matches the unit at which sentence-level PRUS evidence is aggregated in the study. The website does not ask coders to judge isolated sentences.

A post is coded **PRUS** when its title, one sentence, or several connected passages introduce or explore an uncertain possibility about the game or product experience. The rest of the post may contain factual, affective, or otherwise non-PRUS material. Coders select every applicable product topic domain for PRUS-positive posts.

## Files

- `index.html`: validation interface
- `styles.css`: responsive site styling
- `app.js`: browser persistence, secure checkpoints, resume, and response export
- `config.js`: secure response endpoint and checkpoint interval
- `worker/`: Cloudflare Worker that validates submissions and writes them to the private GitHub response repository
- `data/sample_posts.json`: blinded 500-post validation sample used by the site

Model labels, class allocation, sampling strata, selection thresholds, randomization details, and diagnostic materials are retained outside the public application repository. The browser receives only the post information required to complete the exercise.

The captured body sometimes ends with an ellipsis because the source Steam discussion corpus retained a topic summary/excerpt rather than retrieving a later full thread page. The validation interface reproduces the same captured text that entered the sentence-level analysis, preserving measurement alignment.

## Local Use

```bash
python3 -m http.server 8787
```

Open `http://127.0.0.1:8787`.

## Persistence and Secure Collection

The site stores a browser copy of participant progress in `localStorage` and sends secure checkpoints to a Cloudflare Worker. The Worker validates each submission and commits the latest post-validation record to the private `daakrofi/prus-human-validation-responses` repository.

Post-level responses are stored under a separate `responses/post-validation-v1/` namespace. This prevents records from the superseded sentence-level exercise from being overwritten or mistaken for post-level validation data.

Participant email addresses are normalized and hashed before the GitHub path is created. Names, email addresses, and telephone numbers do not appear in filenames or commit messages. They remain inside the response JSON in the private repository.

The site creates a remote checkpoint every 25 completed posts, when the participant selects **Save and Exit**, and after all 500 posts have been completed. Browser-side checkpoint requests are serialized and coalesced. The Worker retries transient GitHub conflicts and prevents an older checkpoint from replacing a more advanced participant record.

## Response Export

At completion, coders can download CSV or JSON backups containing participant details, post metadata and displayed text, the human PRUS label, all selected product topic domains, and the answer timestamp. Model labels are joined only after collection through the private audit file.
