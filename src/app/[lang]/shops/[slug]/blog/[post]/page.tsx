import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { BlogPostView, blogPostMetadata } from "../BlogViews";

export async function generateMetadata({ params }: PageProps<"/[lang]/shops/[slug]/blog/[post]">): Promise<Metadata> {
  const { lang, slug, post } = await params;
  if (!isLocale(lang)) return {};
  return await blogPostMetadata(lang, slug, post, false);
}

export default async function BlogPostPage({ params, searchParams }: PageProps<"/[lang]/shops/[slug]/blog/[post]">) {
  const { lang, slug, post } = await params;
  const original = (await searchParams).original === "1";
  if (!isLocale(lang)) notFound();
  return <BlogPostView lang={lang} slug={slug} postSlug={post} onSite={false} original={original} />;
}
