import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { BlogListView, blogListMetadata, pageNumber } from "./BlogViews";

export async function generateMetadata({ params, searchParams }: PageProps<"/[lang]/shops/[slug]/blog">): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return await blogListMetadata(lang, slug, pageNumber(await searchParams), false);
}

export default async function BlogPage({ params, searchParams }: PageProps<"/[lang]/shops/[slug]/blog">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  return <BlogListView lang={lang} slug={slug} sp={await searchParams} onSite={false} />;
}
