import { plans, formatPrice } from './membership.js';

export function initHome(window = globalThis.window) {
  const document = window.document;

  document.querySelectorAll('.plans .plan').forEach((card, index) => {
    const plan = plans[index];
    card.querySelector('h3').textContent = plan.name.toUpperCase();
    card.querySelector('.price').innerHTML = `${formatPrice(plan.price)} <small>/mo</small>`;
    card.querySelector('ul').replaceChildren(...plan.benefits.map(benefit => {
      const item = document.createElement('li');
      item.textContent = benefit;
      return item;
    }));
    card.querySelector('a').href = `checkout.html?plan=${plan.id}`;
  });

  const menuToggle = document.querySelector(".menu-toggle");
  const nav = document.querySelector(".main-nav");

  menuToggle?.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    menuToggle.setAttribute("aria-expanded", String(open));
  });

  document.querySelectorAll(".main-nav a").forEach(link => {
    link.addEventListener("click", () => {
      nav?.classList.remove("open");
      menuToggle?.setAttribute("aria-expanded", "false");
    });
  });

  const sections = [...document.querySelectorAll("main section[id]")];
  const navLinks = [...document.querySelectorAll('.main-nav a[href^="#"]')];

  const observer = typeof window.IntersectionObserver === "function" ? new window.IntersectionObserver(entries => {
    const visible = entries
      .filter(entry => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

    if (!visible) return;

    navLinks.forEach(link => {
      link.classList.toggle(
        "active",
        link.getAttribute("href") === `#${visible.target.id}`
      );
    });
  }, { rootMargin: "-35% 0px -55% 0px", threshold: [0, .2, .5] }) : null;

  sections.forEach(section => observer?.observe(section));

}
if (typeof document !== 'undefined') initHome();
