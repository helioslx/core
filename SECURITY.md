# Security policy

## Supported versions

Before `1.0`, security fixes are provided for the latest published minor
release. After `1.0`, the latest major release receives security fixes; older
branches may receive fixes at maintainer discretion.

| Version | Supported |
| --- | --- |
| Latest published release | Yes |
| Older releases | No |

## Reporting a vulnerability

Do not open a public issue, discussion, or pull request for a suspected
vulnerability.

Use GitHub's private vulnerability reporting feature from the repository
**Security** tab. Include:

- affected versions and export subpaths
- impact and realistic threat model
- minimal reproduction or proof of concept
- required configuration and runtime
- suggested mitigation, if known
- whether details have been shared elsewhere

Remove production credentials, personal data, venue identifiers, and unsafe
live-lighting instructions. Use synthetic data and an isolated environment.

Maintainers aim to acknowledge a complete report within five business days.
They will validate impact, coordinate a fix and advisory, and provide status
updates when practical. Timelines depend on severity and release coordination.
Please allow a reasonable remediation period before disclosure.

## Scope

Relevant reports include authentication-boundary mistakes in the adapter,
unsafe parsing or resource exhaustion, dependency compromise, Redis record
trust issues, network-originated crashes, provenance/release compromise, and
vulnerabilities in package code.

The following are generally out of scope unless they demonstrate a package
defect:

- exposed applications that did not configure the documented authentication,
  binding, CORS, TLS, or rate limits
- denial of service requiring unrestricted access intentionally granted by the
  host
- issues only in unsupported Node versions, browsers, or edge runtimes
- social engineering, physical attacks, and scanner-only reports without
  demonstrated impact
- vulnerabilities exclusively in a dependency that should be reported to that
  dependency first

Operational safety incidents are important but are not automatically security
vulnerabilities. Follow
[live-lighting safety](https://docs.helioslx.com/docs/core/guides/safety)
immediately and use private reporting if an attacker can trigger the behavior.

## Disclosure

The project follows coordinated disclosure. Confirmed issues may receive a
GitHub security advisory, CVE where appropriate, patched release with npm
provenance, changelog entry, and remediation guidance. Reporters may be
credited with permission.
