import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Heading from '@theme/Heading';
import CodeBlock from '@theme/CodeBlock';

import styles from './styles.module.css';

const FLOW_STEPS = [
  'Developer',
  'Asterweave',
  'Repository context',
  'Specs',
  'Agents + skills',
  'Verification',
  'PR / CI',
];

const CAPABILITIES: {title: string; description: string}[] = [
  {title: 'Repository-aware', description: 'Discovers and preserves the architecture already in your repository instead of imposing one.'},
  {title: 'Spec-driven', description: 'Reads and links to specs/ when one exists, with proportional rigor for the size of the change.'},
  {title: 'Agentic', description: 'Thirteen narrowly scoped specialists, least-privilege by design, delegated bounded work per graph node.'},
  {title: 'Resumable', description: 'Durable workflow state and an append-only event ledger — a new session picks up exactly where the last one stopped.'},
  {title: 'Verification-first', description: 'A passing unit test is context, not proof. Runtime acceptance evidence is independent and required.'},
  {title: 'Safe automation', description: 'Pauses for human approval after planning and before push/PR; never merges, self-approves, or force-pushes.'},
  {title: 'Extensible', description: 'A repository can route stages to project-specific agents and add quality gates — never remove a mandatory one.'},
];

function HomepageHeader() {
  const logoUrl = useBaseUrl('img/asterweave.png');
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <img src={logoUrl} alt="Asterweave" className={styles.logo} />
        <Heading as="h1" className="hero__title">
          Asterweave
        </Heading>
        <p className="hero__subtitle">Reusable agentic software delivery for Claude Code.</p>
        <p className={styles.positioning}>
          Define the goal. Asterweave understands the repository, coordinates specialized agents,
          implements the change, verifies it, and drives delivery to a pull request — pausing for
          your approval at the decisions that are still yours to make.
        </p>
        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/getting-started/installation">
            Get started
          </Link>
          <Link className="button button--secondary button--lg" to="/architecture/overview">
            Architecture
          </Link>
          <Link className="button button--secondary button--lg" to="/commands/overview">
            Commands
          </Link>
          <Link className="button button--secondary button--lg" href="https://github.com/anjotadena/asterweave">
            GitHub
          </Link>
        </div>
      </div>
    </header>
  );
}

function FlowSection() {
  return (
    <section className={styles.section}>
      <div className="container">
        <Heading as="h2" className={styles.sectionTitle}>
          How it fits together
        </Heading>
        <p className={styles.sectionSubtitle}>
          One deterministic graph connects a goal to a verified pull request.
        </p>
        <div className={styles.flow}>
          {FLOW_STEPS.map((step, i) => (
            <div key={step} style={{display: 'contents'}}>
              <div className={styles.flowStep}>{step}</div>
              {i < FLOW_STEPS.length - 1 && <div className={styles.flowArrow}>↓</div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CapabilitiesSection() {
  return (
    <section className={styles.sectionAlt}>
      <div className="container">
        <Heading as="h2" className={styles.sectionTitle}>
          What Asterweave is
        </Heading>
        <p className={styles.sectionSubtitle}>Not full autonomy where human approval is still required — deliberate, verifiable delivery.</p>
        <div className={styles.capGrid}>
          {CAPABILITIES.map((cap) => (
            <div key={cap.title} className={styles.capCard}>
              <h3>{cap.title}</h3>
              <p>{cap.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function QuickStartSection() {
  return (
    <section className={styles.section}>
      <div className="container">
        <Heading as="h2" className={styles.sectionTitle}>
          Get started in two commands
        </Heading>
        <p className={styles.sectionSubtitle}>
          Align the repository once, then deliver work items whenever you have one.
        </p>
        <div className={styles.quickStartGrid}>
          <div className={styles.quickStartStep}>
            <h3>1. Align your repository</h3>
            <CodeBlock language="text">{'/asterweave:scaffold'}</CodeBlock>
            <p>
              Reads your code, tests, and CI, then proposes an evidence-backed <code>CLAUDE.md</code>,{' '}
              <code>.claude/rules/</code>, and <code>.claude/asterweave.json</code> for your approval.
            </p>
          </div>
          <div className={styles.quickStartStep}>
            <h3>2. Deliver a work item</h3>
            <CodeBlock language="text">{'/asterweave:deliver owner/repository#123'}</CodeBlock>
            <p>
              Analyzes, plans, implements, tests, verifies, reviews, and opens a pull request —
              pausing for your approval before push/PR unless invoked with <code>--auto-pr</code>.
            </p>
          </div>
        </div>
        <div className={styles.ctaRow}>
          <Link className="button button--primary button--md" to="/usage/daily-workflow">
            Daily workflow
          </Link>
          <Link className="button button--secondary button--md" to="/commands/overview">
            Command reference
          </Link>
          <Link className="button button--secondary button--md" to="/architecture/overview">
            Architecture
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Homepage(): ReactNode {
  return (
    <>
      <HomepageHeader />
      <FlowSection />
      <CapabilitiesSection />
      <QuickStartSection />
    </>
  );
}
