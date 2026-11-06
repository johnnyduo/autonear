// What the owner has to do in MetaMask's OWN Send screen when a website may not send the one-time relayer setup (see explainWalletError in ../wallet/nearEth.js).
// Pure: the values come from the failed call itself (the exact transaction the app tried to send), so they are always the right ones for this account and this moment.
export function onboardRows(setup) {
  if (!setup || !/^0x[0-9a-fA-F]{40}$/.test(setup.to ?? '') || !/^0x[0-9a-fA-F]+$/.test(setup.data ?? '')) return null;
  const gwei = Number(BigInt(setup.gasPrice)) / 1e9;
  return [
    { key: 'network', label: 'Network', value: `${setup.network ?? 'NEAR testnet (EVM wallet)'} (chain id ${setup.chainId})`, copy: null },
    { key: 'to', label: 'To (your own address)', value: setup.to, copy: setup.to },
    { key: 'amount', label: 'Amount', value: '0', copy: '0' },
    { key: 'data', label: 'Hex data', value: `${setup.data.slice(0, 18)}… (${(setup.data.length - 2) / 2} bytes)`, copy: setup.data },
    { key: 'gas', label: 'Gas limit (set by hand)', value: String(setup.gasLimit), copy: String(setup.gasLimit) },
    { key: 'price', label: 'Gas price', value: `${gwei} gwei`, copy: null },
  ];
}
export const ONBOARD_STEPS = Object.freeze([
  'Open MetaMask, go to Settings, then Advanced, and turn on "Show hex data". Switch MetaMask to the network shown below.',
  'Press Send inside MetaMask (not on this page). Paste the To address, set the Amount to 0 and paste the Hex data.',
  'Press Edit gas and set the Gas limit by hand to the number shown. The automatic number is too low and the step would fail.',
  'Confirm, wait about a minute, then come back and press the button again. This setup is needed only once for this wallet.',
]);
