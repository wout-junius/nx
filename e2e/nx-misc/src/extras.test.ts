import { parseJson } from '@nx/devkit';
import {
  checkFilesExist,
  cleanupProject,
  isNotWindows,
  newProject,
  readJson,
  runCLI,
  setMaxWorkers,
  uniq,
  updateFile,
  readFile,
  updateJson,
} from '@nx/e2e/utils';
import { join } from 'path';

describe('Extra Nx Misc Tests', () => {
  beforeAll(() => newProject({ packages: ['@nx/web', '@nx/js', '@nx/react'] }));
  afterAll(() => cleanupProject());

  describe('Output Style', () => {
    it('should stream output', async () => {
      const myapp = 'abcdefghijklmon';
      runCLI(`generate @nx/web:app ${myapp}`);
      setMaxWorkers(join('apps', myapp, 'project.json'));

      updateJson(join('apps', myapp, 'project.json'), (c) => {
        c.targets['inner'] = {
          command: 'echo inner',
        };
        c.targets['echo'] = {
          executor: 'nx:run-commands',
          options: {
            commands: ['echo 1', 'echo 2', `nx inner ${myapp}`],
            parallel: false,
          },
        };
        return c;
      });

      const withPrefixes = runCLI(`echo ${myapp} --output-style=stream`).split(
        isNotWindows() ? '\n' : '\r\n'
      );
      expect(withPrefixes).toContain(`${myapp}: 1`);
      expect(withPrefixes).toContain(`${myapp}: 2`);
      expect(withPrefixes).toContain(`${myapp}: inner`);

      const noPrefixes = runCLI(
        `echo ${myapp} --output-style=stream-without-prefixes`
      );
      expect(noPrefixes).not.toContain(`${myapp}: `);
    });
  });

  describe('Nx Plugins', () => {
    it('should use plugins defined in nx.json', () => {
      const nxJson = readJson('nx.json');
      nxJson.plugins = ['./tools/plugin'];
      updateFile('nx.json', JSON.stringify(nxJson));
      updateFile(
        'tools/plugin.js',
        `
      module.exports = {
        processProjectGraph: (graph) => {
          const Builder = require('@nx/devkit').ProjectGraphBuilder;
          const builder = new Builder(graph);
          builder.addNode({
            name: 'plugin-node',
            type: 'lib',
            data: {
              root: 'test'
            }
          });
          builder.addNode({
            name: 'plugin-node2',
            type: 'lib',
            data: {
              root: 'test2'
            }
          });
          builder.addImplicitDependency(
            'plugin-node',
            'plugin-node2'
          );
          return builder.getUpdatedProjectGraph();
        }
      };
    `
      );

      runCLI('graph --file project-graph.json');
      const projectGraphJson = readJson('project-graph.json');
      expect(projectGraphJson.graph.nodes['plugin-node']).toBeDefined();
      expect(projectGraphJson.graph.nodes['plugin-node2']).toBeDefined();
      expect(projectGraphJson.graph.dependencies['plugin-node']).toContainEqual(
        {
          type: 'implicit',
          source: 'plugin-node',
          target: 'plugin-node2',
        }
      );
    });
  });

  describe('Run Commands', () => {
    const mylib = uniq('lib');
    beforeAll(() => {
      runCLI(`generate @nx/js:lib ${mylib}`);
    });

    it('should not override environment variables already set when setting a custom env file path', async () => {
      updateFile(
        `.env`,
        'SHARED_VAR=shared-root-value\nROOT_ONLY=root-only-value'
      );

      updateFile(
        `apps/${mylib}/.custom.env`,
        'SHARED_VAR=shared-nested-value\nNESTED_ONLY=nested-only-value'
      );

      const envFile = `apps/${mylib}/.custom.env`;
      runCLI(
        `generate @nx/workspace:run-commands echoEnvVariables --command=echo --envFile=${envFile} --project=${mylib}`
      );

      const command =
        process.platform === 'win32'
          ? `%SHARED_VAR% %ROOT_ONLY% %NESTED_ONLY%` // Windows
          : `$SHARED_VAR $ROOT_ONLY $NESTED_ONLY`;
      updateJson(join('libs', mylib, 'project.json'), (config) => {
        config.targets.echoEnvVariables.options.command += ` ${command}`;
        return config;
      });

      const result = runCLI(`run ${mylib}:echoEnvVariables`);
      expect(result).toContain('shared-root-value');
      expect(result).not.toContain('shared-nested-value');
      expect(result).toContain('root-only-value');
      expect(result).toContain('nested-only-value');
    }, 120000);

    it('should pass options', async () => {
      updateJson(join('libs', mylib, 'project.json'), (config) => {
        config.targets.echo = {
          command: 'echo --var1={args.var1}',
          options: {
            var1: 'a',
          },
        };
        return config;
      });

      const result = runCLI(`run ${mylib}:echo`, { silent: true });
      expect(result).toContain('--var1=a');
    }, 120000);

    it('should interpolate provided arguments', async () => {
      const echoTarget = uniq('echo');
      updateJson(join('libs', mylib, 'project.json'), (config) => {
        config.targets[echoTarget] = {
          executor: 'nx:run-commands',
          options: {
            commands: [
              'echo "Arguments:"',
              'echo "  var1: {args.var1}"',
              'echo "  var2: {args.var2}"',
              'echo "  hyphen: {args.var-hyphen}"',
              'echo "  camel: {args.varCamelCase}"',
              'echo ""',
            ],
          },
        };
        return config;
      });

      const result = runCLI(
        `run ${mylib}:${echoTarget} --var1=a --var2=b --var-hyphen=c --varCamelCase=d`
      );
      expect(result).toContain('var1: a');
      expect(result).toContain('var2: b');
      expect(result).toContain('hyphen: c');
      expect(result).toContain('camel: d');

      const resultArgs = runCLI(
        `run ${mylib}:${echoTarget} --args="--var1=a --var2=b --var-hyphen=c --varCamelCase=d"`
      );
      expect(resultArgs).toContain('var1: a');
      expect(resultArgs).toContain('var2: b');
      expect(resultArgs).toContain('hyphen: c');
      expect(resultArgs).toContain('camel: d');
    }, 120000);

    it('should fail when a process exits non-zero', async () => {
      updateJson(join('libs', mylib, 'project.json'), (config) => {
        config.targets.error = {
          executor: 'nx:run-commands',
          options: {
            command: `exit 1`,
          },
        };
        return config;
      });

      try {
        runCLI(`run ${mylib}:error`);
        fail('Should error if process errors');
      } catch (e) {
        expect(e.stderr.toString()).toContain(
          'command "exit 1" exited with non-zero status code'
        );
      }
    });

    it('run command should not break if output property is missing in options and arguments', async () => {
      updateJson(join('libs', mylib, 'project.json'), (config) => {
        config.targets.lint.outputs = ['{options.outputFile}'];
        return config;
      });

      expect(() =>
        runCLI(`run ${mylib}:lint --format=json`, {
          silenceError: true,
        })
      ).not.toThrow();
    }, 1000000);

    it('should handle caching output directories containing trailing slashes', async () => {
      // this test relates to https://github.com/nrwl/nx/issues/10549
      // 'cp -a /path/dir/ dest/' operates differently to 'cp -a /path/dir dest/'
      // --> which means actual build works but subsequent populate from cache (using cp -a) does not
      // --> the fix is to remove trailing slashes to ensure consistent & expected behaviour

      const mylib = uniq('lib');

      const folder = `dist/libs/${mylib}/some-folder`;

      runCLI(`generate @nx/js:lib ${mylib}`);

      runCLI(
        `generate @nx/workspace:run-commands build --command=echo --outputs=${folder}/ --project=${mylib}`
      );

      const commands = [
        process.platform === 'win32'
          ? `mkdir ${folder}` // Windows
          : `mkdir -p ${folder}`,
        `echo dummy > ${folder}/dummy.txt`,
      ];
      updateJson(join('libs', mylib, 'project.json'), (config) => {
        delete config.targets.build.options.command;
        config.targets.build.options = {
          ...config.targets.build.options,
          parallel: false,
          commands: commands,
        };
        return config;
      });

      // confirm that it builds correctly
      runCLI(`build ${mylib}`);
      checkFilesExist(`${folder}/dummy.txt`);

      // confirm that it populates correctly from the cache
      runCLI(`build ${mylib}`);
      checkFilesExist(`${folder}/dummy.txt`);
    }, 120000);
  });

  describe('generate --quiet', () => {
    it('should not log tree operations or install tasks', () => {
      const output = runCLI('generate @nx/react:app --quiet test-project', {
        verbose: false,
      });
      expect(output).not.toContain('CREATE');
      expect(output).not.toContain('Installed');
    });
  });

  describe('Env File', () => {
    it('should have the right env', () => {
      const appName = uniq('app');
      runCLI(
        `generate @nx/react:app ${appName} --style=css --bundler=webpack --no-interactive`
      );
      updateFile(
        '.env',
        `FIRSTNAME="firstname"
  LASTNAME="lastname"
  NX_USERNAME=$FIRSTNAME $LASTNAME`
      );
      updateFile(
        `apps/${appName}/src/app/app.tsx`,
        `
      import NxWelcome from './nx-welcome';
  
      export function App() {
        return (
          <>
            <NxWelcome title={process.env.NX_USERNAME} />
          </>
        );
      }
  
      export default App;
    `
      );
      updateFile(
        `apps/${appName}/src/app/app.spec.tsx`,
        `import { render } from '@testing-library/react';
  
    import App from './app';
    
    describe('App', () => {
      it('should have a greeting as the title', () => {
        const { getByText } = render(<App />);
        expect(getByText(/Welcome firstname lastname/gi)).toBeTruthy();
      });
    });
  `
      );
      const unitTestsOutput = runCLI(`test ${appName}`);
      expect(unitTestsOutput).toContain('Successfully ran target test');
    });
  });

  describe('task graph inputs', () => {
    const readExpandedTaskInputResponse = (): Record<
      string,
      Record<string, string[]>
    > =>
      parseJson(
        readFile('static/environment.js').match(
          /window\.expandedTaskInputsResponse\s*=\s*(.*?);/
        )[1]
      );

    const baseLib = 'lib-base-123';
    beforeAll(() => {
      runCLI(`generate @nx/js:lib ${baseLib}`);
    });

    it('should correctly expand default task inputs', () => {
      runCLI('graph --file=graph.html');

      expect(readExpandedTaskInputResponse()[`${baseLib}:build`])
        .toMatchInlineSnapshot(`
        {
          "external": [
            "npm:@nx/js",
            "npm:tslib",
          ],
          "general": [
            ".gitignore",
            "nx.json",
          ],
          "lib-base-123": [
            "libs/lib-base-123/README.md",
            "libs/lib-base-123/package.json",
            "libs/lib-base-123/project.json",
            "libs/lib-base-123/src/index.ts",
            "libs/lib-base-123/src/lib/lib-base-123.ts",
            "libs/lib-base-123/tsconfig.json",
            "libs/lib-base-123/tsconfig.lib.json",
          ],
        }
      `);
    });

    it('should correctly expand dependent task inputs', () => {
      const dependentLib = 'lib-dependent-123';
      runCLI(`generate @nx/js:lib ${dependentLib}`);

      updateJson(join('libs', baseLib, 'project.json'), (config) => {
        config.targets['build'].inputs = ['default', '^default'];
        config.implicitDependencies = [dependentLib];
        return config;
      });

      updateJson('nx.json', (json) => {
        json.namedInputs = {
          ...json.namedInputs,
          default: ['{projectRoot}/**/*'],
        };
        return json;
      });
      runCLI('graph --file=graph.html');

      expect(readExpandedTaskInputResponse()[`${baseLib}:build`])
        .toMatchInlineSnapshot(`
        {
          "external": [
            "npm:@nx/js",
            "npm:tslib",
          ],
          "general": [
            ".gitignore",
            "nx.json",
          ],
          "lib-base-123": [
            "libs/lib-base-123/.eslintrc.json",
            "libs/lib-base-123/README.md",
            "libs/lib-base-123/jest.config.ts",
            "libs/lib-base-123/package.json",
            "libs/lib-base-123/project.json",
            "libs/lib-base-123/src/index.ts",
            "libs/lib-base-123/src/lib/lib-base-123.spec.ts",
            "libs/lib-base-123/src/lib/lib-base-123.ts",
            "libs/lib-base-123/tsconfig.json",
            "libs/lib-base-123/tsconfig.lib.json",
            "libs/lib-base-123/tsconfig.spec.json",
          ],
          "lib-dependent-123": [
            "libs/lib-dependent-123/.eslintrc.json",
            "libs/lib-dependent-123/README.md",
            "libs/lib-dependent-123/jest.config.ts",
            "libs/lib-dependent-123/package.json",
            "libs/lib-dependent-123/project.json",
            "libs/lib-dependent-123/src/index.ts",
            "libs/lib-dependent-123/src/lib/lib-dependent-123.spec.ts",
            "libs/lib-dependent-123/src/lib/lib-dependent-123.ts",
            "libs/lib-dependent-123/tsconfig.json",
            "libs/lib-dependent-123/tsconfig.lib.json",
            "libs/lib-dependent-123/tsconfig.spec.json",
          ],
        }
      `);
    });
  });
});
