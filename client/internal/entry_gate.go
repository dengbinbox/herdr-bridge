package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
)

func validateEntryURL(server, entry string) error {
	if entry == "" {
		return nil
	}
	base, err := url.Parse(server)
	if err != nil {
		return errors.New("invalid server_url")
	}
	u, err := url.Parse(entry)
	if err != nil || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.Scheme != base.Scheme || !strings.EqualFold(u.Host, base.Host) || u.Path == "" || u.Path == "/" || u.RawQuery == "" {
		return errors.New("entry_url must be an absolute URL on the server_url origin with a path and query")
	}
	return nil
}

func entryClient(ctx context.Context, c Config) (*http.Client, error) {
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if c.EntryURL == "" {
		return client, nil
	}
	if err := validateEntryURL(c.ServerURL, c.EntryURL); err != nil {
		return nil, err
	}
	jar, _ := cookiejar.New(nil)
	client.Jar = jar
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.EntryURL, nil)
	if err != nil {
		return nil, errors.New("invalid entry_url")
	}
	res, err := client.Do(req)
	// Do not expose the private entrance URL through wrapped HTTP errors.
	if err != nil {
		return nil, errors.New("entry cookie request failed")
	}
	res.Body.Close()
	target, _ := url.Parse(c.ServerURL)
	target.Path = "/bridge/v1/connect"
	if res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/ui/" || len(jar.Cookies(target)) == 0 {
		return nil, errors.New("entry cookie request rejected")
	}
	return client, nil
}
