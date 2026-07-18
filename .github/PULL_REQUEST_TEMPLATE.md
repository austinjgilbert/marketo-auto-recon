## Description

<!-- Describe what this PR does and why. Link to any relevant issues. -->

Closes #

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation / trust-signal update (no code change)
- [ ] CI / tooling update

## Checklist

- [ ] I have read [CONTRIBUTING](CONTRIBUTING.md) (if it exists) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [ ] My changes do not modify `src/` or `bin/` unintentionally (`git diff --stat HEAD -- src/ bin/` is empty for doc-only PRs)
- [ ] `npm test` passes locally (84/84 declarations pass)
- [ ] No new npm dependencies have been added (zero-dependency constraint preserved)
- [ ] I have not committed `.mse-config.json` or any file containing credentials
- [ ] Documentation has been updated to reflect any behavior changes

## Testing

<!-- Describe how you tested this change. For code changes, include the test output. -->

```
npm test
# paste output here
```

## Security note

This tool handles Marketo OAuth credentials and optionally Claude API keys. If your
change touches credential handling, authentication, or data transmission, please call
that out explicitly here.
