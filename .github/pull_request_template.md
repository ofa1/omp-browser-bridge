# GitHub Pull Request Template

## Description
<!-- Describe your changes in detail. What problem does this solve? -->

## Related Issues
<!-- Link to related issue(s), e.g. Fixes #123 -->

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Documentation update
- [ ] Refactoring or code cleanup
- [ ] Platform / installer improvement

## Testing & Verification
<!-- Describe the tests you ran to verify your changes. Include OS and Firefox versions. -->
- [ ] `npm run lint:addon` passes without warnings/errors
- [ ] `node --check host/host.mjs` and `node --check scripts/install-host.mjs` pass
- [ ] Tested in local Firefox profile (`npm run dev` or `/firefox setup`)
- [ ] Verified commands and tools in omp (`/firefox on`, `/firefox status`, etc.)

## Checklist
- [ ] My code follows the repository conventions and style.
- [ ] I have updated relevant documentation (`README.md`, `CHANGELOG.md`, etc.).
- [ ] If changing extension APIs or manifest, versions in `package.json` and `firefox/manifest.json` are consistent.
