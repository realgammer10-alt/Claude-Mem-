
import { describe, it, expect } from 'bun:test';
import { isProjectExcluded, matchesAnyGlob } from '../../src/utils/project-filter.js';
import { homedir } from 'os';

describe('Project Filter', () => {
  describe('matchesAnyGlob', () => {
    it('matches full paths and basenames', () => {
      expect(matchesAnyGlob('/workspace/client/project', ['/workspace/*/project'])).toBe(true);
      expect(matchesAnyGlob('/workspace/client/project', ['project'])).toBe(true);
      expect(matchesAnyGlob('/workspace/client/other', ['project'])).toBe(false);
    });

    it('supports home-directory expansion and ignores empty patterns', () => {
      const home = homedir();

      expect(matchesAnyGlob(`${home}/private/project`, ['', '~/private/**'])).toBe(true);
      expect(matchesAnyGlob(`${home}/public/project`, ['', '   '])).toBe(false);
    });

    it('allows a middle globstar to match zero or more directories', () => {
      expect(matchesAnyGlob('/workspace/foo/bar/project', ['/workspace/foo/**/bar/project'])).toBe(true);
      expect(matchesAnyGlob('/workspace/foo/nested/bar/project', ['/workspace/foo/**/bar/project'])).toBe(true);
    });

    it('allows a leading globstar to match zero or more directories', () => {
      expect(matchesAnyGlob('foo/project', ['**/foo/project'])).toBe(true);
      expect(matchesAnyGlob('workspace/foo/project', ['**/foo/project'])).toBe(true);
    });

    it('normalizes Windows-style paths', () => {
      expect(matchesAnyGlob('C:\\workspace\\client\\project', ['C:/workspace/*/project'])).toBe(true);
    });

    it('matches paths with trailing separators', () => {
      expect(matchesAnyGlob('/workspace/client/project/', ['/workspace/*/project'])).toBe(true);
      expect(matchesAnyGlob('/workspace/client/project/', ['project'])).toBe(true);
    });

    it('preserves Windows drive roots during normalization', () => {
      expect(matchesAnyGlob('C:\\', ['C:/'])).toBe(true);
    });

    it('normalizes UNC paths', () => {
      expect(matchesAnyGlob('\\\\server\\share\\project', ['//server/share/*'])).toBe(true);
    });

    it('treats placeholder-like path text literally', () => {
      expect(matchesAnyGlob('/workspace/<<<GLOBSTAR>>>', ['/workspace/<<<GLOBSTAR>>>'])).toBe(true);
      expect(matchesAnyGlob('/workspace/other', ['/workspace/<<<GLOBSTAR>>>'])).toBe(false);
    });

    it('normalizes trailing separators in patterns', () => {
      expect(matchesAnyGlob('/workspace/client/project', ['/workspace/*/project/'])).toBe(true);
      expect(matchesAnyGlob('/workspace/client/project', ['/workspace/**/'])).toBe(true);
    });
  });

  describe('isProjectExcluded', () => {
    describe('with empty patterns', () => {
      it('returns false for empty pattern string', () => {
        expect(isProjectExcluded('/Users/test/project', '')).toBe(false);
        expect(isProjectExcluded('/Users/test/project', '   ')).toBe(false);
      });
    });

    describe('with exact path matching', () => {
      it('matches exact paths', () => {
        expect(isProjectExcluded('/tmp/secret', '/tmp/secret')).toBe(true);
        expect(isProjectExcluded('/tmp/public', '/tmp/secret')).toBe(false);
      });
    });

    describe('with * wildcard (single directory level)', () => {
      it('matches any directory name', () => {
        expect(isProjectExcluded('/tmp/secret', '/tmp/*')).toBe(true);
        expect(isProjectExcluded('/tmp/anything', '/tmp/*')).toBe(true);
      });

      it('does not match across directory boundaries', () => {
        expect(isProjectExcluded('/tmp/a/b', '/tmp/*')).toBe(false);
      });
    });

    describe('with ** wildcard (any path depth)', () => {
      it('matches any path depth', () => {
        expect(isProjectExcluded('/Users/test/kunden/client1/project', '/Users/*/kunden/**')).toBe(true);
        expect(isProjectExcluded('/Users/test/kunden/deep/nested/project', '/Users/*/kunden/**')).toBe(true);
      });

      it('matches the base directory at zero depth', () => {
        expect(isProjectExcluded('/Users/test/kunden', '/Users/*/kunden/**')).toBe(true);
      });
    });

    describe('with ? wildcard (single character)', () => {
      it('matches single character', () => {
        expect(isProjectExcluded('/tmp/a', '/tmp/?')).toBe(true);
        expect(isProjectExcluded('/tmp/ab', '/tmp/?')).toBe(false);
      });
    });

    describe('with ~ home directory expansion', () => {
      it('expands ~ to home directory', () => {
        const home = homedir();
        expect(isProjectExcluded(`${home}/secret`, '~/secret')).toBe(true);
        expect(isProjectExcluded(`${home}/projects/secret`, '~/projects/*')).toBe(true);
      });
    });

    describe('with multiple patterns', () => {
      it('returns true if any pattern matches', () => {
        const patterns = '/tmp/*,~/kunden/*,/var/secret';
        expect(isProjectExcluded('/tmp/test', patterns)).toBe(true);
        expect(isProjectExcluded(`${homedir()}/kunden/client`, patterns)).toBe(true);
        expect(isProjectExcluded('/var/secret', patterns)).toBe(true);
        expect(isProjectExcluded('/home/user/public', patterns)).toBe(false);
      });
    });

    describe('with Windows-style paths', () => {
      it('normalizes backslashes to forward slashes', () => {
        expect(isProjectExcluded('C:\\Users\\test\\secret', 'C:/Users/*/secret')).toBe(true);
      });
    });

    describe('real-world patterns', () => {
      it('excludes customer projects', () => {
        const patterns = '~/kunden/*,~/customers/**';
        const home = homedir();

        expect(isProjectExcluded(`${home}/kunden/acme-corp`, patterns)).toBe(true);
        expect(isProjectExcluded(`${home}/customers/bigco/project1`, patterns)).toBe(true);
        expect(isProjectExcluded(`${home}/projects/opensource`, patterns)).toBe(false);
      });

      it('excludes temporary directories', () => {
        const patterns = '/tmp/*,/var/tmp/*';

        expect(isProjectExcluded('/tmp/scratch', patterns)).toBe(true);
        expect(isProjectExcluded('/var/tmp/test', patterns)).toBe(true);
        expect(isProjectExcluded('/home/user/tmp', patterns)).toBe(false);
      });
    });
  });
});
