import { createCloudFrontEvent } from "../test-utils";
import {
  CloudFrontRequest,
  CloudFrontResultResponse,
  CloudFrontOrigin
} from "aws-lambda";

jest.mock(
  "../../src/prerender-manifest.json",
  () => require("./prerender-manifest.json"),
  {
    virtual: true
  }
);

jest.mock(
  "../../src/routes-manifest.json",
  () => require("./default-basepath-routes-manifest.json"),
  {
    virtual: true
  }
);

const mockPageRequire = (mockPagePath: string): void => {
  jest.mock(
    `../../src/${mockPagePath}`,
    () => require(`../shared-fixtures/built-artifact/${mockPagePath}`),
    {
      virtual: true
    }
  );
};

describe("Lambda@Edge", () => {
  describe.each`
    trailingSlash
    ${false}
    ${true}
  `("Routing with trailingSlash = $trailingSlash", ({ trailingSlash }) => {
    let handler: any;
    let runRedirectTest: (
      path: string,
      expectedRedirect: string,
      querystring?: string
    ) => Promise<void>;
    beforeEach(() => {
      jest.resetModules();

      if (trailingSlash) {
        jest.mock(
          "../../src/manifest.json",
          () => require("./default-build-manifest-with-trailing-slash.json"),
          {
            virtual: true
          }
        );
      } else {
        jest.mock(
          "../../src/manifest.json",
          () => require("./default-build-manifest.json"),
          {
            virtual: true
          }
        );
      }

      // Handler needs to be dynamically required to use above mocked manifests
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      handler = require("../../src/default-handler").handler;

      runRedirectTest = async (
        path: string,
        expectedRedirect: string,
        querystring?: string
      ): Promise<void> => {
        const event = createCloudFrontEvent({
          uri: path,
          host: "mydistribution.cloudfront.net",
          config: { eventType: "origin-request" } as any,
          querystring: querystring
        });

        const result = await handler(event);
        const response = result as CloudFrontResultResponse;

        expect(response.headers).toEqual({
          location: [
            {
              key: "Location",
              value: expectedRedirect
            }
          ],
          refresh: [
            {
              key: "Refresh",
              value: `0;url=${expectedRedirect}`
            }
          ]
        });
        expect(response.status).toEqual("308");
      };
    });

    afterEach(() => {
      jest.unmock("../../src/manifest.json");
    });

    describe("HTML pages routing", () => {
      it.each`
        path                                                        | expectedPage
        ${"/basepath"}                                              | ${"/index.html"}
        ${"/basepath/"}                                             | ${"/index.html"}
        ${"/basepath/index"}                                        | ${"/index.html"}
        ${"/basepath/terms"}                                        | ${"/terms.html"}
        ${"/basepath/users/batman"}                                 | ${"/users/[user].html"}
        ${"/basepath/users/test/catch/all"}                         | ${"/users/[...user].html"}
        ${"/basepath/john/123"}                                     | ${"/[username]/[id].html"}
        ${"/basepath/tests/prerender-manifest/example-static-page"} | ${"/tests/prerender-manifest/example-static-page.html"}
      `(
        "serves page $expectedPage from S3 for path $path",
        async ({ path, expectedPage }) => {
          if (trailingSlash && !path.endsWith("/")) {
            path += "/";
          }

          const event = createCloudFrontEvent({
            uri: path,
            host: "mydistribution.cloudfront.net"
          });

          const result = await handler(event);

          const request = result as CloudFrontRequest;

          expect(request.origin).toEqual({
            s3: {
              authMethod: "origin-access-identity",
              domainName: "my-bucket.s3.amazonaws.com",
              path: "/basepath/static-pages",
              region: "us-east-1"
            }
          });
          expect(request.uri).toEqual(expectedPage);
          expect(request.headers.host[0].key).toEqual("host");
          expect(request.headers.host[0].value).toEqual(
            "my-bucket.s3.amazonaws.com"
          );
        }
      );

      it.each`
        path
        ${"/basepath/terms"}
        ${"/basepath/users/batman"}
        ${"/basepath/users/test/catch/all"}
        ${"/basepath/john/123"}
        ${"/basepath/tests/prerender-manifest/example-static-page"}
        ${"/basepath/tests/prerender-manifest-fallback/not-yet-built"}
      `(
        `path $path redirects if it ${
          trailingSlash ? "does not have" : "has"
        } a trailing slash`,
        async ({ path }) => {
          let expectedRedirect;
          if (trailingSlash) {
            expectedRedirect = path + "/";
          } else {
            expectedRedirect = path;
            path += "/";
          }
          await runRedirectTest(path, expectedRedirect);
        }
      );
    });

    describe("Public files routing", () => {
      it("serves public file from S3 /public folder", async () => {
        const event = createCloudFrontEvent({
          uri: "/basepath/manifest.json",
          host: "mydistribution.cloudfront.net"
        });

        const result = await handler(event);

        const request = result as CloudFrontRequest;

        expect(request.origin).toEqual({
          s3: {
            authMethod: "origin-access-identity",
            domainName: "my-bucket.s3.amazonaws.com",
            path: "/basepath/public",
            region: "us-east-1"
          }
        });
        expect(request.uri).toEqual("/manifest.json");
      });

      it.each`
        path                          | expectedRedirect
        ${"/basepath/favicon.ico/"}   | ${"/basepath/favicon.ico"}
        ${"/basepath/manifest.json/"} | ${"/basepath/manifest.json"}
      `(
        "public files always redirect to path without trailing slash: $path -> $expectedRedirect",
        async ({ path, expectedRedirect }) => {
          await runRedirectTest(path, expectedRedirect);
        }
      );
    });

    describe("SSR pages routing", () => {
      it.each`
        path                                       | expectedPage
        ${"/basepath/abc"}                         | ${"pages/[root].js"}
        ${"/basepath/blog/foo"}                    | ${"pages/blog/[id].js"}
        ${"/basepath/customers"}                   | ${"pages/customers/index.js"}
        ${"/basepath/customers/superman"}          | ${"pages/customers/[customer].js"}
        ${"/basepath/customers/superman/howtofly"} | ${"pages/customers/[customer]/[post].js"}
        ${"/basepath/customers/superman/profile"}  | ${"pages/customers/[customer]/profile.js"}
        ${"/basepath/customers/test/catch/all"}    | ${"pages/customers/[...catchAll].js"}
      `(
        "renders page $expectedPage for path $path",
        async ({ path, expectedPage }) => {
          if (trailingSlash && !path.endsWith("/")) {
            path += "/";
          }

          const event = createCloudFrontEvent({
            uri: path,
            host: "mydistribution.cloudfront.net"
          });

          mockPageRequire(expectedPage);

          const response = await handler(event);

          const cfResponse = response as CloudFrontResultResponse;
          const decodedBody = new Buffer(
            cfResponse.body as string,
            "base64"
          ).toString("utf8");

          expect(decodedBody).toEqual(expectedPage);
          expect(cfResponse.status).toEqual(200);
        }
      );

      it.each`
        path
        ${"/basepath/abc"}
        ${"/basepath/blog/foo"}
        ${"/basepath/customers"}
        ${"/basepath/customers/superman"}
        ${"/basepath/customers/superman/howtofly"}
        ${"/basepath/customers/superman/profile"}
        ${"/basepath/customers/test/catch/all"}
      `(
        `path $path redirects if it ${
          trailingSlash ? "does not have" : "has"
        } trailing slash`,
        async ({ path }) => {
          let expectedRedirect;
          if (trailingSlash) {
            expectedRedirect = path + "/";
          } else {
            expectedRedirect = path;
            path += "/";
          }
          await runRedirectTest(path, expectedRedirect);
        }
      );

      it.each`
        path
        ${"/basepath/abc"}
        ${"/basepath/blog/foo"}
        ${"/basepath/customers"}
        ${"/basepath/customers/superman"}
        ${"/basepath/customers/superman/howtofly"}
        ${"/basepath/customers/superman/profile"}
        ${"/basepath/customers/test/catch/all"}
      `("path $path passes querystring to redirected URL", async ({ path }) => {
        const querystring = "a=1&b=2";

        let expectedRedirect;
        if (trailingSlash) {
          expectedRedirect = `${path}/?${querystring}`;
        } else {
          expectedRedirect = `${path}?${querystring}`;
          path += "/";
        }

        await runRedirectTest(path, expectedRedirect, querystring);
      });
    });

    describe("Data Requests", () => {
      it.each`
        path                                                               | expectedPage
        ${"/basepath/_next/data/build-id/customers.json"}                  | ${"pages/customers/index.js"}
        ${"/basepath/_next/data/build-id/customers/superman.json"}         | ${"pages/customers/[customer].js"}
        ${"/basepath/_next/data/build-id/customers/superman/profile.json"} | ${"pages/customers/[customer]/profile.js"}
      `("serves json data for path $path", async ({ path, expectedPage }) => {
        const event = createCloudFrontEvent({
          uri: path,
          host: "mydistribution.cloudfront.net"
        });

        mockPageRequire(expectedPage);

        const result = await handler(event);

        const request = result as CloudFrontRequest;

        expect(request.origin).toEqual({
          s3: {
            authMethod: "origin-access-identity",
            domainName: "my-bucket.s3.amazonaws.com",
            path: "",
            region: "us-east-1"
          }
        });
        expect(request.uri).toEqual(path);
      });

      it.each`
        path                                                                | expectedRedirect
        ${"/basepath/_next/data/build-id/customers.json/"}                  | ${"/basepath/_next/data/build-id/customers.json"}
        ${"/basepath/_next/data/build-id/customers/superman.json/"}         | ${"/basepath/_next/data/build-id/customers/superman.json"}
        ${"/basepath/_next/data/build-id/customers/superman/profile.json/"} | ${"/basepath/_next/data/build-id/customers/superman/profile.json"}
      `(
        "data requests always redirect to path without trailing slash: $path -> $expectedRedirect",
        async ({ path, expectedRedirect }) => {
          await runRedirectTest(path, expectedRedirect);
        }
      );
    });

    it("uses default s3 endpoint when bucket region is us-east-1", async () => {
      const event = createCloudFrontEvent({
        uri: trailingSlash ? "/basepath/terms/" : "/basepath/terms",
        host: "mydistribution.cloudfront.net",
        s3Region: "us-east-1"
      });

      const result = await handler(event);

      const request = result as CloudFrontRequest;
      const origin = request.origin as CloudFrontOrigin;

      expect(origin.s3).toEqual(
        expect.objectContaining({
          domainName: "my-bucket.s3.amazonaws.com"
        })
      );
      expect(request.headers.host[0].key).toEqual("host");
      expect(request.headers.host[0].value).toEqual(
        "my-bucket.s3.amazonaws.com"
      );
    });

    it("uses regional endpoint for static page when bucket region is not us-east-1", async () => {
      const event = createCloudFrontEvent({
        uri: trailingSlash ? "/basepath/terms/" : "/basepath/terms",
        host: "mydistribution.cloudfront.net",
        s3DomainName: "my-bucket.s3.amazonaws.com",
        s3Region: "eu-west-1"
      });

      const result = await handler(event);

      const request = result as CloudFrontRequest;
      const origin = request.origin as CloudFrontOrigin;

      expect(origin).toEqual({
        s3: {
          authMethod: "origin-access-identity",
          domainName: "my-bucket.s3.eu-west-1.amazonaws.com",
          path: "/basepath/static-pages",
          region: "eu-west-1"
        }
      });
      expect(request.uri).toEqual("/terms.html");
      expect(request.headers.host[0].key).toEqual("host");
      expect(request.headers.host[0].value).toEqual(
        "my-bucket.s3.eu-west-1.amazonaws.com"
      );
    });

    it("uses regional endpoint for public asset when bucket region is not us-east-1", async () => {
      const event = createCloudFrontEvent({
        uri: "/basepath/favicon.ico",
        host: "mydistribution.cloudfront.net",
        s3DomainName: "my-bucket.s3.amazonaws.com",
        s3Region: "eu-west-1"
      });

      const result = await handler(event);

      const request = result as CloudFrontRequest;
      const origin = request.origin as CloudFrontOrigin;

      expect(origin).toEqual({
        s3: {
          authMethod: "origin-access-identity",
          domainName: "my-bucket.s3.eu-west-1.amazonaws.com",
          path: "/basepath/public",
          region: "eu-west-1"
        }
      });
      expect(request.uri).toEqual("/favicon.ico");
      expect(request.headers.host[0].key).toEqual("host");
      expect(request.headers.host[0].value).toEqual(
        "my-bucket.s3.eu-west-1.amazonaws.com"
      );
    });

    describe("404 page", () => {
      it("renders 404 page if request path can't be matched to any page / api routes", async () => {
        const event = createCloudFrontEvent({
          uri: trailingSlash
            ? "/basepath/page/does/not/exist/"
            : "/basepath/page/does/not/exist",
          host: "mydistribution.cloudfront.net"
        });

        mockPageRequire("pages/_error.js");

        const response = (await handler(event)) as CloudFrontResultResponse;
        const body = response.body as string;
        const decodedBody = new Buffer(body, "base64").toString("utf8");

        expect(decodedBody).toEqual("pages/_error.js");
        expect(response.status).toEqual(200);
      });

      it("redirects unmatched request path", async () => {
        let path = "/page/does/not/exist";
        let expectedRedirect;
        if (trailingSlash) {
          expectedRedirect = path + "/";
        } else {
          expectedRedirect = path;
          path += "/";
        }
        await runRedirectTest(path, expectedRedirect);
      });
    });
  });
});
