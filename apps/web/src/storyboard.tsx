import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

type DemoApproval = {
	id: string;
	device: string;
	command: string;
	message: string;
	refs: string[];
	missingRefs: string[];
	duration?: string;
	status: "pending" | "approved" | "denied";
	createdAt: string;
};

type StoryState = {
	id: string;
	title: string;
	moment: string;
	description: string;
	approval?: DemoApproval;
};

const demoApproval: DemoApproval = {
	id: "demo-approval",
	device: "Netanel's MacBook Pro",
	command: "npm run sync:stripe",
	message: "Update billing webhooks and verify the Stripe account configuration.",
	refs: ["stripe/live-api-key", "stripe/webhook-secret"],
	missingRefs: [],
	duration: "30 minutes",
	status: "pending",
	createdAt: "Today, 10:42",
};

const missingSecretApproval: DemoApproval = {
	...demoApproval,
	id: "demo-missing-secret",
	command: "npm run rotate-openai-key",
	message: "Rotate the OpenAI production key after the provider asked for a credential update.",
	refs: ["openai/api-key", "openai/api-key-2026-06-21"],
	missingRefs: ["openai/api-key-2026-06-21"],
	duration: undefined,
};

const storyStates: StoryState[] = [
	{
		id: "install",
		title: "Install App",
		moment: "First phone open",
		description: "The owner gets clear iPhone install steps before relying on notifications.",
	},
	{
		id: "push",
		title: "Enable Push",
		moment: "Home-screen launch",
		description: "The app asks for the one permission that makes agent approvals immediate.",
	},
	{
		id: "home-ready",
		title: "Ready Home",
		moment: "Nothing is on fire",
		description: "The owner can see whether approvals, vault key, and machines are healthy in one glance.",
	},
	{
		id: "approval",
		title: "Approve Access",
		moment: "Agent needs a secret",
		description: "The phone notification opens directly to the human decision, with why, what, who, and for how long.",
		approval: demoApproval,
	},
	{
		id: "missing-secret",
		title: "Create While Approving",
		moment: "Requested ref does not exist yet",
		description: "The owner creates or generates the missing value on-device, then approves one encrypted grant.",
		approval: missingSecretApproval,
	},
	{
		id: "pairing",
		title: "Pair Machine",
		moment: "New machine wants admission",
		description: "A six-digit code becomes a plain-language device admission decision.",
	},
	{
		id: "locked",
		title: "Locked Vault",
		moment: "Passkey required",
		description: "The product explains the next human action without exposing cryptographic internals.",
	},
	{
		id: "approved",
		title: "Grant Approved",
		moment: "Decision complete",
		description: "The owner gets a receipt that says what was released and when access ends.",
	},
	{
		id: "empty",
		title: "Empty Vault",
		moment: "No secrets yet",
		description: "A first-time vault should guide the owner toward pairing and approval-time creation.",
	},
];

function ShieldIcon() {
	return (
		<span className="native-icon shield" aria-hidden="true">
			<span />
		</span>
	);
}

function KeyIcon() {
	return (
		<span className="native-icon key" aria-hidden="true">
			<span />
		</span>
	);
}

function DeviceIcon() {
	return (
		<span className="native-icon device" aria-hidden="true">
			<span />
		</span>
	);
}

function StatusTile({ label, value, tone = "ok" }: { label: string; value: string; tone?: "ok" | "warn" | "cold" }) {
	return (
		<div className={`story-status-tile ${tone}`}>
			<span>{label}</span>
			<strong>{value}</strong>
		</div>
	);
}

function HomeScene() {
	return (
		<div className="story-phone-screen">
			<header className="native-large-title">
				<div>
					<span>My vault</span>
					<h1>All quiet</h1>
				</div>
				<ShieldIcon />
			</header>
			<section className="native-primary-card">
				<div className="approval-card-top">
					<span className="live-dot" />
					<strong>No pending grants</strong>
				</div>
				<p>Agents can ask from paired machines. You approve exact refs from this phone.</p>
			</section>
			<div className="story-status-grid">
				<StatusTile label="Push" value="Enabled" />
				<StatusTile label="Vault key" value="Unlocked" />
				<StatusTile label="Machines" value="2 paired" tone="cold" />
				<StatusTile label="Secrets" value="14 refs" tone="cold" />
			</div>
			<section className="native-section">
				<h2>Recent activity</h2>
				<div className="timeline-list">
					<div>
						<KeyIcon />
						<p>
							<strong>Stripe grant approved</strong>
							<span>7 minutes ago, expired after one run</span>
						</p>
					</div>
					<div>
						<DeviceIcon />
						<p>
							<strong>Work laptop paired</strong>
							<span>Yesterday at 18:04</span>
						</p>
					</div>
				</div>
			</section>
		</div>
	);
}

function InstallScene() {
	return (
		<div className="story-phone-screen">
			<header className="native-large-title">
				<div>
					<span>First step</span>
					<h1>Install on this phone</h1>
				</div>
				<ShieldIcon />
			</header>
			<section className="native-primary-card setup-card">
				<h2>Approvals belong on your home screen</h2>
				<p>Install Sickrat so notifications and approval links always open in the same secure app.</p>
			</section>
			<section className="native-section">
				<h2>iPhone setup</h2>
				<div className="timeline-list">
					<div>
						<span className="step-dot">1</span>
						<p>
							<strong>Tap Share in Safari</strong>
							<span>Use the browser share sheet</span>
						</p>
					</div>
					<div>
						<span className="step-dot">2</span>
						<p>
							<strong>Add to Home Screen</strong>
							<span>Name it Sickrat</span>
						</p>
					</div>
					<div>
						<span className="step-dot">3</span>
						<p>
							<strong>Open the new icon</strong>
							<span>Then enable approvals</span>
						</p>
					</div>
				</div>
			</section>
			<div className="story-decision-bar single">
				<button type="button">Copy vault link</button>
			</div>
		</div>
	);
}

function PushScene() {
	return (
		<div className="story-phone-screen">
			<header className="native-large-title">
				<div>
					<span>Home-screen app</span>
					<h1>Turn on approvals</h1>
				</div>
				<KeyIcon />
			</header>
			<section className="native-primary-card setup-card">
				<div className="approval-card-top">
					<span className="live-dot" />
					<strong>Notify me when agents ask</strong>
				</div>
				<p>Pairing requests and secret grants should reach you immediately, even when the app is closed.</p>
				<button type="button">Enable notifications</button>
			</section>
			<section className="native-section">
				<h2>What you will see</h2>
				<div className="timeline-list">
					<div>
						<DeviceIcon />
						<p>
							<strong>Pairing requests</strong>
							<span>Approve new machines by code</span>
						</p>
					</div>
					<div>
						<KeyIcon />
						<p>
							<strong>Secret grant requests</strong>
							<span>Approve exact refs for one command</span>
						</p>
					</div>
				</div>
			</section>
		</div>
	);
}

function ApprovalScene({ approval }: { approval: DemoApproval }) {
	const missing = approval.missingRefs.length > 0;
	return (
		<div className="story-phone-screen decision-scene">
			<header className="native-large-title">
				<div>
					<span>{approval.duration ? "Timed access" : "One-time grant"}</span>
					<h1>{missing ? "Create secret" : "Approve access?"}</h1>
				</div>
				<KeyIcon />
			</header>
			<section className={`native-primary-card ${missing ? "needs-value" : ""}`}>
				<div className="approval-card-top">
					<span className="machine-avatar">MB</span>
					<div>
						<strong>{approval.device}</strong>
						<span>{approval.createdAt}</span>
					</div>
				</div>
				<p>{approval.message}</p>
				<div className="command-chip">{approval.command}</div>
				{approval.duration ? (
					<div className="duration-banner">
						<span>Reusable window</span>
						<strong>{approval.duration}</strong>
					</div>
				) : null}
			</section>
			<section className="native-section">
				<h2>Requested refs</h2>
				<div className="ref-stack">
					{approval.refs.map((ref) => (
						<div className={approval.missingRefs.includes(ref) ? "missing" : ""} key={ref}>
							<span>{ref}</span>
							<strong>{approval.missingRefs.includes(ref) ? "Needs value" : "Stored"}</strong>
						</div>
					))}
				</div>
			</section>
			{missing ? (
				<section className="native-section generated-secret">
					<h2>New value</h2>
					<label>
						<span>openai/api-key-2026-06-21</span>
						<input readOnly value="sk_live_••••••••••••••••" />
					</label>
					<div className="inline-actions">
						<button type="button" className="secondary">
							Show
						</button>
						<button type="button">Generate</button>
					</div>
				</section>
			) : null}
			<div className="story-decision-bar">
				<button type="button" className="deny">
					Deny
				</button>
				<button type="button">{missing ? "Save & approve" : "Approve"}</button>
			</div>
		</div>
	);
}

function PairingScene() {
	return (
		<div className="story-phone-screen">
			<header className="native-large-title">
				<div>
					<span>New machine</span>
					<h1>Pair machine</h1>
				</div>
				<DeviceIcon />
			</header>
			<section className="native-primary-card pairing-hero">
				<span>Verification code</span>
				<strong>482 913</strong>
				<p>Confirm this code matches the terminal before allowing the machine to request grants.</p>
			</section>
			<section className="native-section">
				<h2>Machine details</h2>
				<div className="detail-list">
					<div>
						<span>Name</span>
						<strong>Netanel's MacBook Pro</strong>
					</div>
					<div>
						<span>Terminal command</span>
						<strong>sickrat pair</strong>
					</div>
					<div>
						<span>Expires</span>
						<strong>In 4 minutes</strong>
					</div>
				</div>
			</section>
			<div className="story-decision-bar">
				<button type="button" className="secondary">
					Cancel
				</button>
				<button type="button">Allow machine</button>
			</div>
		</div>
	);
}

function LockedScene() {
	return (
		<div className="story-phone-screen">
			<header className="native-large-title">
				<div>
					<span>Passkey required</span>
					<h1>Unlock vault</h1>
				</div>
				<ShieldIcon />
			</header>
			<section className="native-primary-card locked-card">
				<div className="lock-orbit">
					<ShieldIcon />
				</div>
				<h2>Use Face ID or device passcode</h2>
				<p>Your phone decrypts the local vault key only for this approval. Secret values stay off the server.</p>
				<button type="button">Unlock with passkey</button>
			</section>
			<section className="native-section">
				<h2>What happens next</h2>
				<div className="timeline-list">
					<div>
						<span className="step-dot">1</span>
						<p>
							<strong>Decrypt requested refs</strong>
							<span>Only in this app session</span>
						</p>
					</div>
					<div>
						<span className="step-dot">2</span>
						<p>
							<strong>Seal a machine grant</strong>
							<span>Readable only by the requesting machine</span>
						</p>
					</div>
				</div>
			</section>
		</div>
	);
}

function ApprovedScene() {
	return (
		<div className="story-phone-screen">
			<header className="native-large-title">
				<div>
					<span>Grant sealed</span>
					<h1>Approved</h1>
				</div>
				<ShieldIcon />
			</header>
			<section className="native-primary-card receipt-card">
				<div className="receipt-mark">✓</div>
				<h2>Netanel's MacBook Pro can continue</h2>
				<p>The requested refs were encrypted for this machine only. The app never sent plaintext to chat.</p>
			</section>
			<section className="native-section">
				<h2>Receipt</h2>
				<div className="detail-list">
					<div>
						<span>Command</span>
						<strong>npm run sync:stripe</strong>
					</div>
					<div>
						<span>Released</span>
						<strong>2 refs</strong>
					</div>
					<div>
						<span>Access ends</span>
						<strong>Today at 11:12</strong>
					</div>
				</div>
			</section>
			<div className="story-decision-bar single">
				<button type="button">Done</button>
			</div>
		</div>
	);
}

function EmptyScene() {
	return (
		<div className="story-phone-screen">
			<header className="native-large-title">
				<div>
					<span>New vault</span>
					<h1>Start with a machine</h1>
				</div>
				<DeviceIcon />
			</header>
			<section className="native-primary-card locked-card">
				<div className="lock-orbit">
					<DeviceIcon />
				</div>
				<h2>No machines or secrets yet</h2>
				<p>Pair your first machine. When an agent asks for a missing ref, you can create it during approval.</p>
				<button type="button">Pair a machine</button>
			</section>
			<section className="native-section">
				<h2>Next best actions</h2>
				<div className="story-status-grid">
					<StatusTile label="Push" value="Enable" tone="warn" />
					<StatusTile label="Vault key" value="Create" tone="warn" />
					<StatusTile label="Machines" value="0" tone="cold" />
					<StatusTile label="Secrets" value="0" tone="cold" />
				</div>
			</section>
		</div>
	);
}

function renderScene(state: StoryState) {
	if (state.approval) return <ApprovalScene approval={state.approval} />;
	if (state.id === "install") return <InstallScene />;
	if (state.id === "push") return <PushScene />;
	if (state.id === "pairing") return <PairingScene />;
	if (state.id === "locked") return <LockedScene />;
	if (state.id === "approved") return <ApprovedScene />;
	if (state.id === "empty") return <EmptyScene />;
	return <HomeScene />;
}

export function Storyboard() {
	const [searchParams, setSearchParams] = useSearchParams();
	const initialState = storyStates.find((state) => state.id === searchParams.get("state")) ?? storyStates[0];
	const [selected, setSelected] = useState(initialState);

	function selectState(state: StoryState) {
		setSelected(state);
		setSearchParams({ state: state.id }, { replace: true });
	}

	return (
		<main className="storyboard-page">
			<header className="storyboard-header">
				<Link to="/" className="story-back">
					Sickrat
				</Link>
				<div>
					<span>Mobile product storyboard</span>
					<h1>Human approval moments</h1>
				</div>
			</header>
			<section className="storyboard-layout">
				<aside className="story-rail" aria-label="Storyboard states">
					{storyStates.map((state) => (
						<button
							className={selected.id === state.id ? "active" : "secondary"}
							key={state.id}
							type="button"
							onClick={() => selectState(state)}
						>
							<span>{state.moment}</span>
							<strong>{state.title}</strong>
						</button>
					))}
				</aside>
				<div className="phone-stage">
					<div className="phone-frame" aria-label={`${selected.title} mobile preview`}>
						{renderScene(selected)}
					</div>
				</div>
				<aside className="story-notes">
					<span>Current state</span>
					<h2>{selected.title}</h2>
					<p>{selected.description}</p>
					<div className="story-contract">
						<strong>Backend contract assumed</strong>
						<span>Approvals, devices, secrets, passkey unlock, push routing.</span>
					</div>
				</aside>
			</section>
		</main>
	);
}
