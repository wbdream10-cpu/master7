'use client';
import {useLayoutEffect,useRef,type ReactNode} from 'react';

export default function Dialog({busy,onClose,children}:{busy:boolean;onClose:()=>void;children:ReactNode}){
 const ref=useRef<HTMLDialogElement>(null);
 useLayoutEffect(()=>{
  const dialog=ref.current!;
  const opener=document.activeElement;
  const overflow=document.body.style.overflow;
  dialog.showModal();
  document.body.style.overflow='hidden';
  dialog.querySelector<HTMLElement>('input:not([type="checkbox"]),textarea,select')?.focus();
  return()=>{
   dialog.close();
   document.body.style.overflow=overflow;
   if(opener instanceof HTMLElement&&opener.isConnected)opener.focus();
  };
 },[]);
 return <dialog ref={ref} className="modal" aria-labelledby="modal-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onKeyDown={event=>{
  if(event.key!=='Tab')return;
  const controls=Array.from(ref.current!.querySelectorAll<HTMLElement>('button,a[href],input,textarea,select,[tabindex]')).filter(element=>element.tabIndex>=0&&!element.matches(':disabled')&&element.getClientRects().length>0);
  const first=controls[0],last=controls.at(-1);
  if(!first){event.preventDefault();ref.current!.focus();return;}
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last!.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
 }}>{children}</dialog>;
}
