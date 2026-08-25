# Release process

1. Update `CHANGELOG.md`, `package.json`, and `package-lock.json`.
2. Run the complete gate:

   ```bash
   npm run verify
   npm audit
   npm pack --dry-run
   ```

3. Install the tarball into a temporary consumer project and run the packaged CLI.
4. Commit and push `main`; require public CI to pass.
5. Create an immutable version tag and GitHub Release.
6. Publish the exact tarball as the public scoped npm package.
7. Verify `npm view @muratkomurcu/dry-run version` and install from the registry in a clean temporary directory.

Package scope and GitHub owner intentionally differ:

- npm: `@muratkomurcu/dry-run`
- GitHub: `MuratKomurcu1/dry-run`

Every GitHub-facing URL must use the latter.
