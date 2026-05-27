# slack

Read and write Slack messages, channels, and reactions. Uses `$SLACK_BOT_TOKEN`
(already in env).

## Invoke

```
node $SKILLS_DIR/slack/bin/slack <subcommand> [args]
```

All output is JSON on stdout. Exit 0 = ok, 1 = API error, 2 = bad arguments.

## Subcommands

- `send <channel> <text> [--thread-ts <ts>]`
  Post a message. With `--thread-ts`, posts as a thread reply.

- `list <channel> [--thread-ts <ts>] [--limit N]`
  Channel history (default) or thread replies (with `--thread-ts`).

- `react <channel> <ts> <emoji>`
  Add a reaction.

- `raw <method> '<json-params>'`
  Escape hatch — call any Slack Web API method directly.
  Example: `raw users.info '{"user":"U123"}'`

## Examples

Reply in thread:
```
node $SKILLS_DIR/slack/bin/slack send C0B78ND1LQG "Hi" --thread-ts 1779872551.798819
```

Get the last 5 messages in a channel:
```
node $SKILLS_DIR/slack/bin/slack list C0B78ND1LQG --limit 5
```
