# Contributing

Contributions are welcome! Here's how to help:

## Quick Start

```bash
git clone https://github.com/anneschuth/claude-threads.git
cd claude-threads
bun install
bun run dev
```

## Development

Requires [Bun](https://bun.sh/) 1.2.21+ and Node 20+.

- `bun install` - Install dependencies
- `bun run dev` - Watch mode for development
- `bun run build` - Build for production
- `bun test` - Run the unit tests (~2500 of them)
- `bun run lint` - Check code style

### Integration Tests

Integration tests run the real bot against a Mattermost instance in Docker with a mock Claude CLI. They need Docker running.

- `bun run test:integration:setup` - Start Mattermost in Docker and seed users and channels
- `bun run test:integration:run` - Run the integration suite
- `bun run test:integration:teardown` - Stop Mattermost and clean up

`bun run test:integration` chains setup and run in one command.

### Adding a Platform

Want to add support for another chat platform? Start with [`src/platform/IMPLEMENTATION_GUIDE.md`](src/platform/IMPLEMENTATION_GUIDE.md), which walks through the `PlatformClient` interface and what each platform needs to implement.

## Pull Requests

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Ensure tests pass (`bun test`)
4. Ensure linting passes (`bun run lint`)
5. Submit a pull request

## Reporting Bugs

Open an issue with:
- What you expected
- What actually happened
- Steps to reproduce

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
