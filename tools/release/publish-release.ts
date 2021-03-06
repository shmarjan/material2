import {bold, green, italic, red, yellow} from 'chalk';
import {execSync} from 'child_process';
import {readFileSync} from 'fs';
import {join} from 'path';
import {BaseReleaseTask} from './base-release-task';
import {GitClient} from './git/git-client';
import {getGithubReleasesUrl} from './git/github-urls';
import {isNpmAuthenticated, runInteractiveNpmLogin, runNpmPublish} from './npm/npm-client';
import {promptForNpmDistTag} from './prompt/npm-dist-tag-prompt';
import {checkReleasePackage} from './release-output/check-packages';
import {releasePackages} from './release-output/release-packages';
import {parseVersionName, Version} from './version-name/parse-version';

/** Maximum allowed tries to authenticate NPM. */
const MAX_NPM_LOGIN_TRIES = 2;

/**
 * Class that can be instantiated in order to create a new release. The tasks requires user
 * interaction/input through command line prompts.
 */
class PublishReleaseTask extends BaseReleaseTask {

  /** Path to the project package JSON. */
  packageJsonPath: string;

  /** Serialized package.json of the specified project. */
  packageJson: any;

  /** Parsed current version of the project. */
  currentVersion: Version;

  /** Path to the release output of the project. */
  releaseOutputPath: string;

  /** Instance of a wrapper that can execute Git commands. */
  git: GitClient;

  constructor(public projectDir: string,
              public repositoryOwner: string,
              public repositoryName: string) {
    super(new GitClient(projectDir,
      `https://github.com/${repositoryOwner}/${repositoryName}.git`));

    this.packageJsonPath = join(projectDir, 'package.json');
    this.releaseOutputPath = join(projectDir, 'dist/releases');

    this.packageJson = JSON.parse(readFileSync(this.packageJsonPath, 'utf-8'));
    this.currentVersion = parseVersionName(this.packageJson.version);

    if (!this.currentVersion) {
      console.error(red(`Cannot parse current version in ${italic('package.json')}. Please ` +
        `make sure "${this.packageJson.version}" is a valid Semver version.`));
      process.exit(1);
    }
  }

  async run() {
    console.log();
    console.log(green('-----------------------------------------'));
    console.log(green(bold('  Angular Material release script')));
    console.log(green('-----------------------------------------'));
    console.log();

    const newVersion = this.currentVersion;
    const newVersionName = this.currentVersion.format();

    // Ensure there are no uncommitted changes. Checking this before switching to a
    // publish branch is sufficient as unstaged changes are not specific to Git branches.
    this.verifyNoUncommittedChanges();

    // Branch that will be used to build the output for the release of the current version.
    const publishBranch = this.switchToPublishBranch(newVersion);

    this.verifyLastCommitVersionBump();
    this.verifyLocalCommitsMatchUpstream(publishBranch);

    const npmDistTag = await promptForNpmDistTag(newVersion);

    // In case the user wants to publish a stable version to the "next" npm tag, we want
    // to double-check because usually only pre-release's are pushed to that tag.
    if (npmDistTag === 'next' && !newVersion.prereleaseLabel) {
      await this.promptStableVersionForNextTag();
    }

    this.buildReleasePackages();
    console.info(green(`  ✓   Built the release output.`));

    this.checkReleaseOutput();
    console.info(green(`  ✓   Release output passed validation checks.`));

    // TODO(devversion): find a way to extract the changelog part just for this version.
    this.git.createTag('HEAD', newVersionName, '');
    console.info(green(`  ✓   Created release tag: "${italic(newVersionName)}"`));

    // Ensure that we are authenticated before running "npm publish" for each package.
    this.checkNpmAuthentication();

    // Just in order to double-check that the user is sure to publish to NPM, we want
    // the user to interactively confirm that the script should continue.
    await this.promptConfirmReleasePublish();

    for (let packageName of releasePackages) {
      this.publishPackageToNpm(packageName, npmDistTag);
    }

    console.log();
    console.info(green(bold(`  ✓   Published all packages successfully`)));
    console.info(yellow(`  ⚠   Please push the newly created tag to Github and draft a new ` +
      `release.`));
    console.info(yellow(
      `      ${getGithubReleasesUrl(this.repositoryOwner, this.repositoryName)}`));
  }

  /**
   * Verifies that the latest commit on the current branch is a version bump from the
   * staging script.
   */
  private verifyLastCommitVersionBump() {
    if (!/chore: bump version/.test(this.git.getCommitTitle('HEAD'))) {
      console.error(red(`  ✘   The latest commit of the current branch does not seem to be a ` +
        `version bump.`));
      console.error(red(`      Please stage the release using the staging script.`));
      process.exit(1);
    }
  }

  /** Builds all release packages that should be published. */
  private buildReleasePackages() {
    const binDir = join(this.projectDir, 'node_modules/.bin');
    const spawnOptions = {cwd: binDir, stdio: 'inherit'};

    // TODO(devversion): I'd prefer disabling the output for those, but it might be only
    // worth if we consider adding some terminal spinner library (like "ora").
    execSync('gulp clean', spawnOptions);
    execSync(`gulp ${releasePackages.map(name => `${name}:build-release`).join(' ')}`,
      spawnOptions);
  }

  /** Checks the release output by running the release-output validations. */
  private checkReleaseOutput() {
    let hasFailed = false;

    releasePackages.forEach(packageName => {
      if (!checkReleasePackage(this.releaseOutputPath, packageName)) {
        hasFailed = true;
      }
    });

    // In case any release validation did not pass, abort the publishing because
    // the issues need to be resolved before publishing.
    if (hasFailed) {
      console.error(red(`  ✘   Release output does not pass all release validations. Please fix ` +
        `all failures or reach out to the team.`));
      process.exit(1);
    }
  }

  /**
   * Prompts the user whether they are sure that the current stable version should be
   * released to the "next" NPM dist-tag.
   */
  private async promptStableVersionForNextTag() {
    if (!await this.promptConfirm(
        'Are you sure that you want to release a stable version to the "next" tag?')) {
      console.log();
      console.log(yellow('Aborting publish...'));
      process.exit(0);
    }
  }


  /**
   * Prompts the user whether he is sure that the script should continue publishing
   * the release to NPM.
   */
  private async promptConfirmReleasePublish() {
    if (!await this.promptConfirm('Are you sure that you want to release now?')) {
      console.log();
      console.log(yellow('Aborting publish...'));
      process.exit(0);
    }
  }

  /**
   * Checks whether NPM is currently authenticated. If not, the user will be prompted to enter
   * the NPM credentials that are necessary to publish the release. We achieve this by basically
   * running "npm login" as a child process and piping stdin/stdout/stderr to the current tty.
   */
  private checkNpmAuthentication() {
    if (isNpmAuthenticated()) {
      console.info(green(`  ✓   NPM is authenticated.`));
      return;
    }

    let failedAuthentication = false;
    console.log(yellow(`  ⚠   NPM is currently not authenticated. Running "npm login"..`));

    for (let i = 0;  i < MAX_NPM_LOGIN_TRIES; i++) {
      if (runInteractiveNpmLogin()) {
        // In case the user was able to login properly, we want to exit the loop as we
        // don't need to ask for authentication again.
        break;
      }

      failedAuthentication = true;
      console.error(red(`  ✘   Could not authenticate successfully. Please try again.`));
    }

    if (failedAuthentication) {
      console.error(red(`  ✘   Could not authenticate after ${MAX_NPM_LOGIN_TRIES} tries. ` +
        `Exiting..`));
      process.exit(1);
    }

    console.info(green(`  ✓   Successfully authenticated NPM.`));
  }

  /** Publishes the specified package within the given NPM dist tag. */
  private publishPackageToNpm(packageName: string, npmDistTag: string) {
    console.info(green(`  ⭮   Publishing "${packageName}"..`));

    const errorOutput = runNpmPublish(join(this.releaseOutputPath, packageName), npmDistTag);

    if (errorOutput) {
      console.error(red(`  ✘   An error occurred while publishing "${packageName}".`));
      console.error(red(`      Please check the terminal output and reach out to the team.`));
      console.error(red(`\n${errorOutput}`));
      process.exit(1);
    }

    console.info(green(`  ✓   Successfully published "${packageName}"`));
  }
}

/** Entry-point for the create release script. */
if (require.main === module) {
  new PublishReleaseTask(join(__dirname, '../../'), 'angular', 'material2').run();
}

