# Publish to npm

The public package is `ultimatehuman`. The repository root and internal workspace packages stay private. The publishable artifact is prepared in `dist/npm`; it contains the bundled CLI and dashboard, README, Apache license, and third-party notices.

## Prepare

1. Update `packages/cli/package.json` with the next version. CLI output and engine health use this version.
2. Update release notes and user documentation for the actual shipped behavior.
3. Run the build and integration checks in [development.md](development.md).

```sh
npx --yes pnpm@11.10.0 release:prepare
npx --yes pnpm@11.10.0 release:check
```

The package check creates `dist/ultimatehuman-VERSION.tgz`, installs it offline into an empty directory, checks the executable, starts its engine, and verifies bundled dashboard assets and API authentication. It does not call Claude, use real trackers, or touch your workspace.

## Publish the tested artifact

Commit the release changes and get the GitHub build/package checks passing before publishing. Authenticate using npm's browser flow; keep credentials out of the repository.

```sh
npm login
npm whoami
npm publish ./dist/ultimatehuman-VERSION.tgz --access public --tag latest
```

Replace `VERSION` with the prepared version. Complete npm's account verification if prompted. Publish the tested tarball, not the repository root or the CLI source workspace.

## Verify

```sh
npm view ultimatehuman version dist.integrity
npx --yes ultimatehuman@latest --version
```

Compare registry integrity with the package check output. Create a matching `vVERSION` Git tag and GitHub release with the install command and release notes. Use a new version for corrections; published versions are immutable.
