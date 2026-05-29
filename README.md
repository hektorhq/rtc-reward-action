# RTC Reward on Merge

A GitHub Action that automatically awards **RTC tokens** to contributors when their pull request is merged. Turn any open-source repository into a crypto bounty platform with a single YAML file.

## Quick Start

```yaml
# .github/workflows/rtc-reward.yml
name: Reward Contributor

on:
  pull_request:
    types: [closed]

jobs:
  reward:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: hektorhq/rtc-reward-action@v1
        with:
          node-url: https://50.28.86.131
          amount: 5
          wallet-from: pool_wallet
          admin-key: ${{ secrets.RTC_ADMIN_KEY }}
```

That's it. When a PR is merged the action resolves the contributor's wallet, calls the RustChain node, and posts a confirmation comment on the PR.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `node-url` | Yes | — | RustChain node URL (e.g. `https://50.28.86.131`) |
| `amount` | No | `5` | RTC tokens to award per merged PR |
| `wallet-from` | Yes | — | Sending wallet name / pool wallet ID |
| `admin-key` | Yes | — | Admin key for authorizing the transfer |
| `wallet-to` | No | — | Override recipient wallet (skips auto-detection) |
| `wallet-field` | No | `RTC Wallet:` | Label in the PR body used to find recipient wallet |
| `dry-run` | No | `false` | Simulate without sending real tokens |
| `github-token` | No | `${{ github.token }}` | Token used to post the reward comment |

## Outputs

| Output | Description |
|---|---|
| `tx-id` | Transaction ID returned by the RustChain node |
| `wallet-to` | Recipient wallet that received the reward |
| `amount` | Amount of RTC awarded |

## Wallet Resolution

The action finds the recipient wallet in this priority order:

1. **`wallet-to` input** — explicit override, skips all detection
2. **PR body** — scans for a line matching `RTC Wallet: <wallet_id>` (field label is configurable)
3. **`.rtc-wallet` file** — reads the workspace root file if it exists
4. **GitHub username** — falls back to the PR author's GitHub login

### Contributor: declare your wallet in the PR body

```
Closes #42

RTC Wallet: my_wallet_name
```

## Dry Run Mode

Test the workflow without sending real tokens:

```yaml
- uses: hektorhq/rtc-reward-action@v1
  with:
    node-url: https://50.28.86.131
    amount: 5
    wallet-from: pool_wallet
    admin-key: ${{ secrets.RTC_ADMIN_KEY }}
    dry-run: 'true'
```

## Use Outputs in Downstream Steps

```yaml
- uses: hektorhq/rtc-reward-action@v1
  id: reward
  with:
    node-url: https://50.28.86.131
    amount: 5
    wallet-from: pool_wallet
    admin-key: ${{ secrets.RTC_ADMIN_KEY }}

- name: Log result
  run: |
    echo "Sent ${{ steps.reward.outputs.amount }} RTC"
    echo "TX: ${{ steps.reward.outputs.tx-id }}"
    echo "To: ${{ steps.reward.outputs.wallet-to }}"
```

## Variable Reward Amounts

```yaml
- uses: hektorhq/rtc-reward-action@v1
  with:
    node-url: https://50.28.86.131
    amount: ${{ contains(github.event.pull_request.labels.*.name, 'major') && '20' || '5' }}
    wallet-from: pool_wallet
    admin-key: ${{ secrets.RTC_ADMIN_KEY }}
```

## RTC Wallet File

Contributors can add a `.rtc-wallet` file to their fork:

```
my_wallet_name
```

The action reads this file if no wallet is found in the PR body.

## Requirements

- Node.js 20 (provided by GitHub-hosted runners — no setup needed)
- No npm dependencies — uses only Node.js built-in modules
- A running RustChain node accessible from GitHub Actions runners

## License

MIT
